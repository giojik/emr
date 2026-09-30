import { BadRequestException, Body, ConflictException, Controller, forwardRef, Get, HttpCode, Inject, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { NotifyService } from '../notify/notify.service';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { StorageService } from '../storage/storage.service';
import { LabConfigService } from './lab-config.service';
import { LabMicroService } from './lab-micro';

/** PDF-ის დაშიფვრა (qpdf, AES-256). qpdf-ის გარეშე — შეცდომა (დაუშიფრავს არ ვაგზავნით) */
async function encryptPdf(buf: Buffer, password: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'labenc-'));
  try {
    await writeFile(join(dir, 'in.pdf'), buf);
    const owner = `${password}-${Math.random().toString(36).slice(2)}`;
    await new Promise<void>((res, rej) => execFile('qpdf', ['--encrypt', password, owner, '256', '--modify=none', '--', join(dir, 'in.pdf'), join(dir, 'out.pdf')],
      { timeout: 30_000 }, (e) => (e && (e as { code?: number }).code !== 3 ? rej(e) : res())));   // 3 = გაფრთხილება (წარმატება)
    return await readFile(join(dir, 'out.pdf'));
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');
const SYSTEM: AuthUser = { id: null as unknown as string, roles: ['admin'] } as unknown as AuthUser;

/**
 * პასუხის მიწოდება პაციენტს (ნაგულისხმევად გამორთულია): ელ-ფოსტა — დაშიფრული PDF(-ები) (ლაბ. ბლანკი, მიკრობიოლოგია, გარე ლაბორატორიის PDF);
 * SMS — მხოლოდ შეტყობინება. ავტომატურად — ვიზიტის ყველა ლაბ. ანალიზის დადასტურების შემდეგ, ერთხელ; ხელით — ვიზიტის ეკრანიდან.
 */
@Injectable()
export class LabDeliveryService {
  private readonly log = new Logger('LabDelivery');
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notify: NotifyService, private readonly storage: StorageService,
    private readonly clinic: ClinicSettingsService, private readonly cfg: LabConfigService, @Inject(forwardRef(() => LabMicroService)) private readonly micro: LabMicroService) {}

  settings() { return this.db.selectFrom('lab_delivery_settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow(); }
  async saveSettings(dto: Partial<{ enabled: boolean; auto_send: boolean; encrypt_pdf: boolean; email_subject: string; email_body: string; sms_email_sent: string; sms_ready: string }>, u: AuthUser, ctx: AuditContext) {
    const old = await this.settings();
    await this.db.updateTable('lab_delivery_settings').set({ ...dto, updated_by: u.id, updated_at: sql`now()` }).where('id', '=', 1).execute();
    await this.audit.log(ctx, { action: 'LAB_DELIVERY_SETTINGS', entityName: 'lab_delivery_settings', entityId: '1', oldData: { enabled: old.enabled, auto_send: old.auto_send, encrypt_pdf: old.encrypt_pdf }, newData: dto });
    return { ...(await this.settings()), configured: this.notify.configured() };
  }

  log_(encounterId: string) {
    return this.db.selectFrom('lab_result_deliveries as d').leftJoin('users as u', 'u.id', 'd.sent_by')
      .select(['d.id', 'd.channel', 'd.recipient', 'd.status', 'd.error', 'd.trigger', 'd.attachments', 'd.created_at', sql<string | null>`u.first_name || ' ' || u.last_name`.as('sent_by_name')])
      .where('d.encounter_id', '=', encounterId).orderBy('d.created_at', 'desc').execute();
  }

  private async state(encounterId: string) {
    const items = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id')
      .select(['i.id', 'i.status', 's.is_micro', 's.name']).where('i.encounter_id', '=', encounterId).where('i.section', '=', 'lab').where('i.status', '<>', 'cancelled').execute();
    const p = await this.db.selectFrom('encounters as e').innerJoin('patients as p', 'p.id', 'e.patient_id')
      .select(['p.id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.phone_number', 'p.email', 'p.result_email', 'p.result_sms']).where('e.id', '=', encounterId).executeTakeFirst();
    if (!p) throw new NotFoundException('ვიზიტი ვერ მოიძებნა');
    return { items, patient: p, allValidated: items.length > 0 && items.every((i) => i.status === 'validated') };
  }

  /** მიმაგრებები: ლაბ. ბლანკი + მიკრობიოლოგიის პასუხები + გარე ლაბორატორიის PDF-ები (დადასტურებული) */
  private async attachments(encounterId: string, items: { id: string; status: string; is_micro: boolean; name: string }[]) {
    const out: { filename: string; content: Buffer }[] = [];
    try { out.push({ filename: 'lab-result.pdf', content: await this.cfg.encounterReport(encounterId) }); } catch { /* ჩვეულებრივი ანალიზი არ არის */ }
    for (const it of items.filter((i) => i.status === 'validated' && i.is_micro)) {
      try { const r = await this.micro.pdf(it.id, SYSTEM); out.push({ filename: `culture-${out.length}.pdf`, content: r as Buffer }); } catch (e) { this.log.warn(`micro PDF: ${(e as Error).message}`); }
    }
    const ext = await this.db.selectFrom('dx_item_files as f').innerJoin('dx_order_items as i', 'i.id', 'f.order_item_id').select(['f.storage_path', 'f.filename'])
      .where('i.encounter_id', '=', encounterId).where('i.status', '=', 'validated').where('f.removed_at', 'is', null).where('f.mime', '=', 'application/pdf').execute();
    for (const f of ext) {
      try { const ch: Buffer[] = []; for await (const c of await this.storage.get(f.storage_path)) ch.push(c as Buffer); out.push({ filename: `external-${out.length}.pdf`, content: Buffer.concat(ch) }); }
      catch (e) { this.log.warn(`external PDF: ${(e as Error).message}`); }
    }
    return out;
  }

  /** გაგზავნა (ავტომატური ან ხელით). channels — რომელი არხებით; to — სხვა მისამართი/ნომერი (ხელით) */
  async send(encounterId: string, o: { trigger: 'auto' | 'manual'; email: boolean; sms: boolean; emailTo?: string | null; phoneTo?: string | null; user: AuthUser | null; ctx: AuditContext }) {
    const s = await this.settings();
    if (!s.enabled) throw new ConflictException('პასუხის მიწოდება გამორთულია (ადმინისტრირება → „პასუხის მიწოდება“)');
    const st = await this.state(encounterId);
    const validated = st.items.filter((i) => i.status === 'validated');
    if (!validated.length) throw new ConflictException('დადასტურებული ლაბორატორიული პასუხი არ არის');
    const c = await this.clinic.get().catch(() => ({ name: 'კლინიკა', phone: '' } as { name: string; phone?: string | null }));
    const vars = { clinic: c.name, phone: c.phone ?? '', name: `${st.patient.first_name} ${st.patient.last_name}`, date: new Date().toLocaleDateString('ka-GE', { timeZone: 'Asia/Tbilisi' }) };
    const res: { channel: string; recipient: string; status: string; error: string | null }[] = [];
    const logRow = async (channel: 'email' | 'sms', recipient: string, ok: boolean, error: string | null, n = 0) => {
      await this.db.insertInto('lab_result_deliveries').values({ encounter_id: encounterId, patient_id: st.patient.id, channel, recipient, status: ok ? 'sent' : 'failed', error, trigger: o.trigger,
        attachments: n, item_ids: validated.map((i) => i.id), sent_by: o.user?.id ?? null }).execute();
      res.push({ channel, recipient, status: ok ? 'sent' : 'failed', error });
    };
    let emailOk = false;
    const emailTo = (o.emailTo ?? st.patient.email)?.trim();
    if (o.email) {
      if (!emailTo) await logRow('email', '—', false, 'პაციენტს ელ-ფოსტა არ აქვს მითითებული');
      else {
        try {
          let files = await this.attachments(encounterId, validated);
          if (!files.length) throw new Error('გასაგზავნი PDF ვერ შეიქმნა');
          const pn = (st.patient.personal_number ?? '').replace(/\D/g, '');
          if (s.encrypt_pdf) {
            if (pn.length < 4) throw new Error('დაშიფვრისთვის პირადი ნომერი საჭიროა (ბოლო 4 ციფრი) — გამორთეთ დაშიფვრა ან შეავსეთ');
            files = await Promise.all(files.map(async (f) => ({ ...f, content: await encryptPdf(f.content, pn.slice(-4)) })));
          }
          const hint = s.encrypt_pdf ? 'PDF დაცულია პაროლით: თქვენი პირადი ნომრის ბოლო 4 ციფრი.' : '';
          const r = await this.notify.email([emailTo], fill(s.email_subject, vars), fill(s.email_body, { ...vars, password_hint: hint }), files.map((f) => ({ ...f, contentType: 'application/pdf' })));
          emailOk = r.sent.length > 0;
          await logRow('email', emailTo, emailOk, r.errors.join('; ') || null, files.length);
        } catch (e) { await logRow('email', emailTo, false, (e as Error).message); }
      }
    }
    const phoneTo = (o.phoneTo ?? st.patient.phone_number)?.trim();
    if (o.sms) {
      if (!phoneTo) await logRow('sms', '—', false, 'ტელეფონი არ არის');
      else {
        const text = fill(emailOk ? s.sms_email_sent : s.sms_ready, vars);
        const r = await this.notify.sms([phoneTo], text);
        await logRow('sms', phoneTo, r.sent.length > 0, r.errors.join('; ') || null);
      }
    }
    await this.audit.log(o.ctx, { action: 'LAB_RESULT_DELIVERY', entityName: 'encounters', entityId: encounterId, newData: { trigger: o.trigger, results: res } });
    return { results: res };
  }

  /** ავტომატური: ჩართულია, ვიზიტის ყველა ლაბ. ანალიზი დადასტურებულია, თანხმობა არის, ჯერ არ გაგზავნილა. შეცდომა — მხოლოდ ჟურნალში */
  async afterValidate(itemId: string, ctx: AuditContext) {
    try {
      const s = await this.settings();
      if (!s.enabled || !s.auto_send) return;
      const it = await this.db.selectFrom('dx_order_items').select('encounter_id').where('id', '=', itemId).executeTakeFirst();
      if (!it?.encounter_id) return;
      const st = await this.state(it.encounter_id);
      if (!st.allValidated || (!st.patient.result_email && !st.patient.result_sms)) return;
      const done = await this.db.selectFrom('lab_result_deliveries').select('id').where('encounter_id', '=', it.encounter_id).where('trigger', '=', 'auto').executeTakeFirst();
      if (done) return;
      await this.send(it.encounter_id, { trigger: 'auto', email: st.patient.result_email, sms: st.patient.result_sms, user: null, ctx });
    } catch (e) { this.log.error(`ავტომატური გაგზავნა: ${(e as Error).message}`); }
  }
}

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean; @IsOptional() @IsBoolean() auto_send?: boolean; @IsOptional() @IsBoolean() encrypt_pdf?: boolean;
  @IsOptional() @IsString() @Length(3, 200) email_subject?: string; @IsOptional() @IsString() @Length(10, 3000) email_body?: string;
  @IsOptional() @IsString() @Length(10, 300) sms_email_sent?: string; @IsOptional() @IsString() @Length(10, 300) sms_ready?: string;
}
class SendDto {
  @IsBoolean() email: boolean; @IsBoolean() sms: boolean;
  @IsOptional() @IsEmail() @MaxLength(150) email_to?: string | null; @IsOptional() @Matches(/^\+?\d{9,15}$/) phone_to?: string | null;
}

@Controller()
export class LabDeliveryController {
  constructor(private readonly d: LabDeliveryService, private readonly notify: NotifyService) {}
  @Get('lab/delivery/settings') @Roles('admin', 'lab_doctor', 'lab_manager', 'receptionist', 'doctor')
  async settings() { return { ...(await this.d.settings()), configured: this.notify.configured() }; }
  @Put('lab/delivery/settings') @Roles('admin')
  save(@Body() dto: SettingsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.d.saveSettings(dto, u, auditCtx(r)); }
  @Get('encounters/:id/lab-deliveries') @Roles('admin', 'lab_doctor', 'lab_manager', 'diagnostic', 'receptionist', 'doctor', 'nurse')
  list(@Param('id', ParseUUIDPipe) id: string) { return this.d.log_(id); }
  @Post('encounters/:id/lab-deliveries') @HttpCode(200) @Roles('admin', 'lab_doctor', 'lab_manager', 'diagnostic', 'receptionist', 'doctor')
  send(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!dto.email && !dto.sms) throw new BadRequestException('აირჩიეთ ელ-ფოსტა და/ან SMS');
    return this.d.send(id, { trigger: 'manual', email: dto.email, sms: dto.sms, emailTo: dto.email_to, phoneTo: dto.phone_to, user: u, ctx: auditCtx(r) });
  }
}
