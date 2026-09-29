import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, Logger, NotFoundException, OnApplicationShutdown, Param, ParseUUIDPipe,
  Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, Length } from 'class-validator';
import type { Request, Response } from 'express';
import { ImapFlow } from 'imapflow';
import { sql } from 'kysely';
import { simpleParser } from 'mailparser';
import { memoryStorage } from 'multer';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { addItemFile } from './lab-item-files';

const MAX_FILE = 15 * 1024 * 1024;
const LAB_STAFF = ['admin', 'diagnostic', 'lab_doctor', 'lab_manager'] as const;
/** ფაილის სახელი: <შტრიხკოდი>.pdf ან <შტრიხკოდი>_<ანალიზის კოდი>.pdf */
const FILE_RE = /^([A-Za-z0-9-]{3,40}?)(?:[_ ]+([A-Za-z0-9_.-]{1,60}))?\.(pdf|jpe?g|png)$/i;
/** თემა: „EMR 1000123“ ან „EMR 1000123, 1000124“ */
const SUBJECT_RE = /\bEMR\b[\s:#-]*([A-Za-z0-9][A-Za-z0-9 ,;#-]*)/i;

// ======================================================================= OCR (Tesseract + pdftoppm; კონტეინერში — Dockerfile)
let ocrLangs: Promise<string | null> | null = null;
const run = (cmd: string, args: string[], timeout = 30_000) => new Promise<string>((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
/** ხელმისაწვდომი ენები: kat+eng (ან რაც არის); null — Tesseract არ არის */
function langs() {
  ocrLangs ??= run('tesseract', ['--list-langs'], 5000).then((o) => {
    const l = o.split(/\s+/).filter((x) => ['kat', 'eng'].includes(x));
    return l.length ? l.join('+') : 'eng';
  }).catch(() => null);
  return ocrLangs;
}
/** სკანი → ტექსტი: PDF — პირველი 3 გვერდი (200 dpi), სურათი — პირდაპირ. ~2–5 წმ გვერდზე. */
async function ocr(buf: Buffer, mime: string): Promise<string | null> {
  const l = await langs();
  if (!l) return null;
  const dir = await mkdtemp(join(tmpdir(), 'labocr-'));
  try {
    const src = join(dir, mime === 'application/pdf' ? 'in.pdf' : mime === 'image/png' ? 'in.png' : 'in.jpg');
    await writeFile(src, buf);
    let images = [src];
    if (mime === 'application/pdf') {
      await run('pdftoppm', ['-r', '200', '-l', '3', '-png', src, join(dir, 'p')], 60_000);
      images = (await readdir(dir)).filter((f) => f.startsWith('p') && f.endsWith('.png')).sort().map((f) => join(dir, f));
    }
    const out: string[] = [];
    for (const img of images) out.push(await run('tesseract', [img, 'stdout', '-l', l, '--psm', '3'], 60_000).catch(() => ''));
    const text = out.join('\n').trim();
    return text || null;
  } catch { return null; } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

export interface MailFileResult { filename: string; status: string; barcode: string | null; service_code: string | null; items: number; reason: string | null; method?: string | null }
interface LabCfg { id: string; name: string; mail_id_regex: string | null; mail_match_patient: boolean; mail_match_window_days: number }

/**
 * გარე ლაბორატორიის პასუხები ელ-ფოსტით: წერილი → მიმაგრებები → შეკვეთის ხაზ(ებ)ი (შტრიხკოდით, საჭიროებისას ანალიზის კოდით).
 * იგივე მიბმა, რაც ხელით ატვირთვისას: status → „ვალიდაციას ელოდება“; ვალიდაცია — ლაბ. ექიმი.
 */
@Injectable()
export class LabMailService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly storage: StorageService) {}

  /** ამ ლაბორატორიაში გაგზავნილი, ჯერ პასუხის გარეშე ანალიზები შტრიხკოდით (და კოდით) */
  private waiting(labId: string | null, barcode: string, code: string | null) {
    let q = this.db.selectFrom('dx_order_items as i').innerJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id').innerJoin('dx_services as s', 's.id', 'i.service_id')
      .select(['i.id', 's.code']).where('i.ext_shipment_id', 'is not', null).where('i.status', 'in', ['in_progress', 'resulted'])   // resulted — დამატებითი ფაილი
      .where((eb) => eb.or([eb('sp.barcode', '=', barcode), eb(sql`ltrim(sp.barcode, '0')`, '=', barcode.replace(/^0+/, ''))]));
    if (labId) q = q.where('i.ext_lab_id', '=', labId);
    if (code) q = q.where(sql`upper(s.code)`, '=', code.toUpperCase());
    return q.execute();
  }

  /** ერთი ანალიზის პასუხად მიბმა (ფაილი უკვე საცავშია) */
  private async link(itemId: string, file: { key: string; name: string; mime: string; size: number; sha256: string | null; mailFileId?: string | null }, userId: string | null, ctx: AuditContext, via: string) {
    return this.db.transaction().execute(async (trx) => {
      const it = await trx.selectFrom('dx_order_items').select(['status', 'ext_shipment_id']).where('id', '=', itemId).forUpdate().executeTakeFirst();
      if (!it?.ext_shipment_id || !['in_progress', 'resulted'].includes(it.status)) throw new ConflictException('ანალიზი არ ელოდება პასუხს (გაუგზავნელი ან დადასტურებული)');
      const added = await addItemFile(trx, { itemId, key: file.key, filename: file.name, mime: file.mime, size: file.size, sha256: file.sha256, source: 'mail', mailFileId: file.mailFileId, userId });
      if (added) await this.audit.log(ctx, { action: 'EXTERNAL_LAB_RESULT', entityName: 'dx_order_items', entityId: itemId, newData: { file: file.name, via } }, trx);
      return added;
    });
  }

  /**
   * ფაილის ტექსტი: ტექსტური PDF — პირდაპირ; სკანი (PDF ტექსტის გარეშე) და JPG/PNG — OCR (Tesseract, ქართული + ლათინური).
   * OCR-ის გარეშე (LAB_MAIL_OCR=false ან პროგრამა არ არის) — ცარიელი. შედეგი ერთი ფაილისთვის კეშირდება (ტესტი + დამუშავება).
   */
  private textCache = new WeakMap<Buffer, Promise<{ text: string; ocr: boolean }>>();
  fileText(buf: Buffer, mime: string) {
    let p = this.textCache.get(buf);
    if (!p) { p = this.extract(buf, mime); this.textCache.set(buf, p); }
    return p;
  }
  private async extract(buf: Buffer, mime: string): Promise<{ text: string; ocr: boolean }> {
    let text = '';
    if (mime === 'application/pdf') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdf = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer, o?: { max?: number }) => Promise<{ text: string }>;
        const r = await Promise.race([pdf(buf, { max: 10 }), new Promise<{ text: string }>((res) => setTimeout(() => res({ text: '' }), 8000))]);
        text = (r.text ?? '').slice(0, 200_000);
      } catch { text = ''; }
    }
    if (text.replace(/\s+/g, '').length >= 30 || !loadEnv().LAB_MAIL_OCR) return { text, ocr: false };
    const o = await ocr(buf, mime);
    return o ? { text: o, ocr: true } : { text, ocr: false };
  }

  /**
   * ფაილის ამოცნობა: 1) ჩვენი ფორმატი (ფაილის სახელი / თემა) → 2) ლაბორატორიის შაბლონი (regex) → 3) პაციენტით (პ/ნ, სახელი+დაბ. თარიღი).
   * მხოლოდ ამ ლაბორატორიაში გაგზავნილ, პასუხის მომლოდინე ანალიზებს შორის. ცვლილებას არ აკეთებს.
   */
  private async matchFile(lab: LabCfg, f: { filename: string; mime: string; content: Buffer }, mailText: { subject: string; body: string; single: boolean }) {
    const subjBarcodes = (SUBJECT_RE.exec(mailText.subject)?.[1] ?? '').split(/[\s,;#]+/).map((x) => x.trim()).filter((x) => /^[A-Za-z0-9-]{3,40}$/.test(x));
    const fm = FILE_RE.exec(f.filename);
    let barcode = fm?.[1] ?? (subjBarcodes.length === 1 ? subjBarcodes[0] : null);
    let code = fm?.[2] ?? null;
    const R = (method: string, items: { id: string }[], reason: string | null = null, candidates: unknown = null) =>
      ({ barcode, code, method, item_ids: items.map((i) => i.id), reason, candidates });
    // 1) ჩვენი ფორმატი
    if (barcode) {
      const items = await this.waiting(lab.id, barcode, code);
      if (items.length) return R(fm ? 'filename' : 'subject', items);
      if (fm && subjBarcodes.length === 1 && subjBarcodes[0] !== barcode) {
        const alt = await this.waiting(lab.id, subjBarcodes[0], null);
        if (alt.length) { barcode = subjBarcodes[0]; code = null; return R('subject', alt); }
      }
    }
    // ტექსტი: ფაილის სახელი + PDF; თემა და ტექსტი — მხოლოდ თუ წერილში ერთი ფაილია (თორემ სხვა ფაილის პაციენტი აირევა)
    const pdf = (await this.fileText(f.content, f.mime)).text;
    const text = [f.filename, pdf, ...(mailText.single ? [mailText.subject, mailText.body] : [])].join('\n');
    // 2) ლაბორატორიის შაბლონი
    if (lab.mail_id_regex) {
      let re: RegExp | null = null;
      try { re = new RegExp(lab.mail_id_regex, 'giu'); } catch { re = null; }
      if (re) {
        const found = [...new Set([...text.slice(0, 50_000).matchAll(re)].map((m) => (m[1] ?? m[0]).trim()).filter(Boolean))].slice(0, 10);
        for (const bc of found) {
          const items = await this.waiting(lab.id, bc, null);
          if (items.length) { barcode = bc; code = null; return R('lab_pattern', items); }
        }
      }
    }
    // 3) პაციენტით
    if (lab.mail_match_patient) {
      const rows = await this.db.selectFrom('dx_order_items as i').innerJoin('patients as p', 'p.id', 'i.patient_id').innerJoin('lab_ext_shipments as sh', 'sh.id', 'i.ext_shipment_id')
        .leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
        .select(['i.id', 'p.id as patient_id', 'p.personal_number', 'p.first_name', 'p.last_name', 'p.birth_date', 'sp.barcode'])
        .where('i.ext_lab_id', '=', lab.id).where('i.status', 'in', ['in_progress', 'resulted'])
        .where('sh.sent_at', '>', sql<Date>`now() - make_interval(days => ${lab.mail_match_window_days})`).execute();
      const low = text.toLowerCase();
      const digits = ` ${text.replace(/[^\d]+/g, ' ')} `;
      const dob = (d: string) => { const [y, m, dd] = d.slice(0, 10).split('-'); return [`${dd}.${m}.${y}`, `${dd}/${m}/${y}`, `${dd}-${m}-${y}`, `${y}-${m}-${dd}`, `${dd}.${m}.${y.slice(2)}`]; };
      const byPatient = new Map<string, { name: string; how: string | null; weak: boolean; items: { id: string }[] }>();
      for (const r of rows) {
        const e = byPatient.get(r.patient_id) ?? { name: `${r.last_name} ${r.first_name}`, how: null as string | null, weak: false, items: [] as { id: string }[] };
        e.items.push({ id: r.id });
        const nameHit = low.includes(r.last_name.toLowerCase()) && low.includes(r.first_name.toLowerCase());
        if (r.personal_number && digits.includes(` ${r.personal_number} `)) e.how = 'personal_number';
        else if (r.barcode && digits.includes(` ${r.barcode} `) && !e.how) e.how = 'barcode_in_text';
        else if (nameHit && dob(r.birth_date).some((x) => text.includes(x)) && !e.how) e.how = 'name_dob';
        else if (nameHit) e.weak = true;
        byPatient.set(r.patient_id, e);
      }
      const strong = [...byPatient.values()].filter((e) => e.how);
      if (strong.length === 1) return { ...R(strong[0].how!, strong[0].items), candidates: null };
      if (strong.length > 1) return R('ambiguous', [], `ფაილში რამდენიმე პაციენტი ამოვიცანი: ${strong.map((e) => e.name).join(', ')} — მიაბით ხელით`, strong.map((e) => ({ name: e.name, how: e.how })));
      const weak = [...byPatient.values()].filter((e) => e.weak);
      if (weak.length) return R('none', [], `შესაძლოა: ${weak.map((e) => e.name).join(', ')} (მხოლოდ სახელით — დაბადების თარიღი / პ/ნ ვერ ვიპოვე). მიაბით ხელით`, weak.map((e) => ({ name: e.name, how: 'name_only' })));
    }
    const validated = barcode ? await this.db.selectFrom('dx_order_items as i').innerJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id').select('i.id')
      .where('i.ext_lab_id', '=', lab.id).where('i.status', '=', 'validated').where('sp.barcode', '=', barcode).executeTakeFirst() : undefined;
    const why = validated ? `${barcode}: პასუხი უკვე დადასტურებულია — დამატებითი ფაილისთვის ლაბ. ექიმმა ჯერ გახსნას (შესწორება), შემდეგ მიაბით ხელით`
      : barcode ? `${barcode}${code ? ` / ${code}` : ''}: ამ ლაბორატორიაში გაგზავნილი, პასუხის მომლოდინე ანალიზი არ არის`
      : pdf ? 'შტრიხკოდი / პაციენტი ვერ ამოვიცანი (ფაილის სახელი, თემა, ფაილის ტექსტი)' : 'შტრიხკოდი ვერ ამოვიცანი; ფაილის ტექსტი ვერ წავიკითხე — მიაბით ხელით';
    return R('none', [], why);
  }

  private async parse(raw: Buffer) {
    const m = await simpleParser(raw);
    const from = (m.from?.value?.[0]?.address ?? '').toLowerCase();
    const lab = from ? await this.db.selectFrom('lab_external_labs').select(['id', 'name', 'mail_id_regex', 'mail_match_patient', 'mail_match_window_days'])
      .where('is_active', '=', true).where(sql<boolean>`${from} = ANY(emails)`).executeTakeFirst() : undefined;
    const files = (m.attachments ?? []).map((a) => ({ filename: (a.filename ?? 'file').replace(/[/\\]/g, '_').slice(0, 200), content: a.content, mime: sniffMime(a.content) }))
      .filter((a): a is { filename: string; content: Buffer; mime: 'application/pdf' | 'image/jpeg' | 'image/png' } => !!a.mime);
    const body = (m.text ?? (typeof m.html === 'string' ? m.html.replace(/<[^>]+>/g, ' ') : '') ?? '').slice(0, 50_000);
    return { m, from, lab, files, mailText: { subject: (m.subject ?? '').slice(0, 500), body, single: files.length === 1 } };
  }

  /** შემოწმება (ცვლილების გარეშე): რას ამოიცნობდა სისტემა — ლაბორატორიის პარამეტრების მოსარგებად */
  async test(raw: Buffer, labId?: string) {
    const p = await this.parse(raw);
    const lab = labId ? await this.db.selectFrom('lab_external_labs').select(['id', 'name', 'mail_id_regex', 'mail_match_patient', 'mail_match_window_days']).where('id', '=', labId).executeTakeFirst() : p.lab;
    const files = [];
    for (const f of p.files) {
      const r = lab ? await this.matchFile(lab, f, p.mailText) : null;
      const items = r?.item_ids.length ? await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').innerJoin('patients as pt', 'pt.id', 'i.patient_id')
        .leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id').select(['i.id', 's.name as service_name', 'sp.barcode', sql<string>`pt.last_name || ' ' || pt.first_name`.as('patient')])
        .where('i.id', 'in', r.item_ids).execute() : [];
      const t = await this.fileText(f.content, f.mime);
      files.push({ filename: f.filename, pdf_text: t.text.replace(/\s+/g, ' ').trim().slice(0, 600), ocr: t.ocr, match: r, items });
    }
    return { from: p.from, subject: p.mailText.subject, lab: lab ? { id: lab.id, name: lab.name } : null, sender_registered: !!p.lab, body: p.mailText.body.replace(/\s+/g, ' ').trim().slice(0, 600), files };
  }

  /** წერილის დამუშავება (IMAP ან .eml ატვირთვა) */
  async ingest(raw: Buffer, source: 'imap' | 'upload', user: AuthUser | null) {
    const p = await this.parse(raw);
    const messageId = (p.m.messageId ?? '').trim() || `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const dup = await this.db.selectFrom('lab_ext_mail').select(['id', 'status']).where('message_id', '=', messageId).executeTakeFirst();
    if (dup) return { mail_id: dup.id, status: dup.status, duplicate: true, files: [] as MailFileResult[] };
    const { from, lab } = p;
    const ctx: AuditContext = { userId: user?.id ?? null, userAgent: `lab-mail (${source}): ${from}` };
    const mail = await this.db.insertInto('lab_ext_mail').values({ message_id: messageId, from_addr: from || null, subject: p.mailText.subject, sent_at: p.m.date ?? null, lab_id: lab?.id ?? null, source,
      status: 'unmatched', uploaded_by: user?.id ?? null }).returning('id').executeTakeFirstOrThrow();
    const out: MailFileResult[] = [];
    for (const f of p.files) {
      if (f.content.length > MAX_FILE) { out.push(await this.file(mail.id, f.filename, f.mime, f.content.length, null, { barcode: null, code: null, method: 'none', reason: 'ფაილი 15 MB-ზე დიდია' }, 'ignored')); continue; }
      const key = `lab-external/mail/${mail.id}/${randomUUID()}.${f.mime === 'application/pdf' ? 'pdf' : f.mime === 'image/png' ? 'png' : 'jpg'}`;
      await this.storage.put(key, f.content, f.mime);
      if (!lab) {
        const fm = FILE_RE.exec(f.filename);
        out.push(await this.file(mail.id, f.filename, f.mime, f.content.length, key, { barcode: fm?.[1] ?? null, code: fm?.[2] ?? null, method: 'none', reason: `უცნობი გამგზავნი (${from || '?'}) — არ არის ლაბორატორიების რეესტრში` }, 'unmatched'));
        continue;
      }
      const r = await this.matchFile(lab, f, p.mailText);
      const sha = createHash('sha256').update(f.content).digest('hex');
      const fid = randomUUID();
      out.push(await this.file(mail.id, f.filename, f.mime, f.content.length, key, r, 'unmatched', [], fid, sha));   // ჯერ ჩანაწერი — ანალიზის ფაილი მას მიუთითებს
      const linked: string[] = [];
      for (const id of r.item_ids) {
        try { await this.link(id, { key, name: f.filename, mime: f.mime, size: f.content.length, sha256: sha, mailFileId: fid }, user?.id ?? null, ctx, `${source}:${r.method}`); linked.push(id); }
        catch { /* სხვამ უკვე დაადასტურა */ }
      }
      if (linked.length) {
        await this.db.updateTable('lab_ext_mail_files').set({ status: 'attached', item_ids: linked, reason: null, match_method: r.method }).where('id', '=', fid).execute();
        out[out.length - 1] = { ...out[out.length - 1], status: 'attached', items: linked.length, reason: null, method: r.method };
      } else if (!r.reason) {
        await this.db.updateTable('lab_ext_mail_files').set({ reason: 'მიბმა ვერ მოხერხდა' }).where('id', '=', fid).execute();
      }
    }
    const att = out.filter((f) => f.status === 'attached').length; const open = out.filter((f) => f.status === 'unmatched').length;
    const status = !lab ? 'rejected' : att && !open ? 'matched' : att ? 'partial' : 'unmatched';
    await this.db.updateTable('lab_ext_mail').set({ status, note: out.length ? null : 'PDF/JPG/PNG მიმაგრება არ არის' }).where('id', '=', mail.id).execute();
    await this.audit.log(ctx, { action: 'EXTERNAL_LAB_MAIL', entityName: 'lab_ext_mail', entityId: mail.id, newData: { from, subject: p.mailText.subject, lab: lab?.name ?? null, status, files: out.length, attached: att } });
    return { mail_id: mail.id, status, duplicate: false, files: out };
  }
  private async file(mailId: string, filename: string, mime: string, size: number, key: string | null,
    r: { barcode: string | null; code: string | null; method: string; reason: string | null; candidates?: unknown }, status: string, items: string[] = [], id?: string, sha?: string) {
    await this.db.insertInto('lab_ext_mail_files').values({ ...(id ? { id } : {}), sha256: sha ?? null, mail_id: mailId, filename, mime, size_bytes: size, storage_path: key, barcode: r.barcode, service_code: r.code, status,
      reason: r.reason, item_ids: items, match_method: status === 'attached' ? r.method : null, candidates: r.candidates ? JSON.stringify(r.candidates) : null }).execute();
    return { filename, status, barcode: r.barcode, service_code: r.code, items: items.length, reason: r.reason, method: status === 'attached' ? r.method : null };
  }

  list(open: boolean) {
    let q = this.db.selectFrom('lab_ext_mail as m').leftJoin('lab_external_labs as l', 'l.id', 'm.lab_id')
      .select(['m.id', 'm.from_addr', 'm.subject', 'm.sent_at', 'm.received_at', 'm.status', 'm.source', 'm.note', 'l.name as lab_name', 'm.lab_id',
        (eb) => eb.selectFrom('lab_ext_mail_files as f').select(sql<unknown>`coalesce(json_agg(json_build_object('id', f.id, 'filename', f.filename, 'status', f.status, 'reason', f.reason,
          'barcode', f.barcode, 'service_code', f.service_code, 'items', cardinality(f.item_ids), 'size', f.size_bytes, 'method', f.match_method, 'candidates', f.candidates) ORDER BY f.filename), '[]')`.as('x')).whereRef('f.mail_id', '=', 'm.id').as('files')])
      .orderBy('m.received_at', 'desc').limit(200);
    if (open) q = q.where((eb) => eb.exists(eb.selectFrom('lab_ext_mail_files as f').select('f.id').whereRef('f.mail_id', '=', 'm.id').where('f.status', '=', 'unmatched')));
    return q.execute();
  }
  async openCount() {
    const r = await this.db.selectFrom('lab_ext_mail_files').select((e) => e.fn.countAll<number>().as('n')).where('status', '=', 'unmatched').executeTakeFirst();
    return Number(r?.n ?? 0);
  }
  async state() {
    const s = await this.db.selectFrom('lab_ext_mail_state').selectAll().where('id', '=', 1).executeTakeFirst();
    const e = loadEnv();
    return { configured: !!e.IMAP_HOST, mailbox: e.IMAP_HOST ? `${e.IMAP_USER ?? ''}@${e.IMAP_HOST}` : null, poll_seconds: e.LAB_MAIL_POLL_SECONDS, ...s, open_files: await this.openCount() };
  }
  async fileStream(id: string) {
    const f = await this.db.selectFrom('lab_ext_mail_files').select(['storage_path', 'mime']).where('id', '=', id).executeTakeFirst();
    if (!f?.storage_path) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    return { stream: await this.storage.get(f.storage_path), mime: f.mime };
  }
  /** ხელით მიბმა: მისაბმელი ფაილი → არჩეული ანალიზ(ებ)ი (გაგზავნილი, პასუხის მომლოდინე) */
  async assign(id: string, itemIds: string[], user: AuthUser, ctx: AuditContext) {
    const f = await this.db.selectFrom('lab_ext_mail_files').select(['id', 'status', 'storage_path', 'filename', 'item_ids', 'mime', 'size_bytes', 'sha256']).where('id', '=', id).executeTakeFirst();
    if (!f?.storage_path) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    if (f.status !== 'unmatched') throw new ConflictException('ფაილი უკვე დამუშავებულია');
    const done: string[] = [];
    for (const itemId of itemIds) {
      await this.link(itemId, { key: f.storage_path, name: f.filename, mime: f.mime, size: f.size_bytes, sha256: f.sha256, mailFileId: f.id }, user.id, ctx, 'mail-manual'); done.push(itemId);
    }
    await this.db.updateTable('lab_ext_mail_files').set({ status: 'attached', item_ids: done, reason: null, resolved_by: user.id, resolved_at: sql`now()` }).where('id', '=', id).execute();
    await this.refreshMail(id);
    return { id, status: 'attached', items: done.length };
  }
  async dismiss(id: string, reason: string, user: AuthUser, ctx: AuditContext) {
    const r = await this.db.updateTable('lab_ext_mail_files').set({ status: 'dismissed', reason: reason.trim(), resolved_by: user.id, resolved_at: sql`now()` })
      .where('id', '=', id).where('status', '=', 'unmatched').returning('id').executeTakeFirst();
    if (!r) throw new BadRequestException('ფაილი ვერ მოიძებნა ან უკვე დამუშავებულია');
    await this.audit.log(ctx, { action: 'EXTERNAL_LAB_MAIL_DISMISS', entityName: 'lab_ext_mail_files', entityId: id, newData: { reason } });
    await this.refreshMail(id);
    return { id, status: 'dismissed' };
  }
  private async refreshMail(fileId: string) {
    await sql`UPDATE lab_ext_mail m SET status = CASE
        WHEN m.lab_id IS NULL AND EXISTS (SELECT 1 FROM lab_ext_mail_files f WHERE f.mail_id = m.id AND f.status = 'unmatched') THEN 'rejected'
        WHEN NOT EXISTS (SELECT 1 FROM lab_ext_mail_files f WHERE f.mail_id = m.id AND f.status = 'unmatched') THEN 'matched'
        WHEN EXISTS (SELECT 1 FROM lab_ext_mail_files f WHERE f.mail_id = m.id AND f.status = 'attached') THEN 'partial' ELSE m.status END
      WHERE m.id = (SELECT mail_id FROM lab_ext_mail_files WHERE id = ${fileId})`.execute(this.db);
  }
}

/** IMAP: ყუთის პერიოდული შემოწმება (emr-worker). დამუშავებული წერილი გადადის საქაღალდეში IMAP_DONE_MAILBOX. */
@Injectable()
export class LabMailPoller implements OnApplicationShutdown {
  private readonly env = loadEnv();
  private readonly log = new Logger('LabMail');
  private timer: NodeJS.Timeout | null = null; private busy = false;
  constructor(@InjectDb() private readonly db: Database, private readonly mail: LabMailService) {}

  start() {
    if (!this.env.IMAP_HOST || !this.env.IMAP_USER) { this.log.log('IMAP არ არის კონფიგურირებული — გარე ლაბორატორიის ელ-ფოსტა გამორთულია'); return; }
    this.log.log(`IMAP: ${this.env.IMAP_USER}@${this.env.IMAP_HOST}:${this.env.IMAP_PORT}, ყოველ ${this.env.LAB_MAIL_POLL_SECONDS} წმ`);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.env.LAB_MAIL_POLL_SECONDS * 1000);
  }
  async poll() {
    if (this.busy) return; this.busy = true;
    const client = new ImapFlow({ host: this.env.IMAP_HOST!, port: this.env.IMAP_PORT, secure: this.env.IMAP_SECURE, logger: false,
      auth: { user: this.env.IMAP_USER!, pass: this.env.IMAP_PASS ?? '' }, tls: { rejectUnauthorized: this.env.IMAP_TLS_VERIFY } });
    let n = 0;
    try {
      await client.connect();
      const done = this.env.IMAP_DONE_MAILBOX;
      const boxes = await client.list();
      if (!boxes.some((b) => b.path === done)) await client.mailboxCreate(done).catch(() => undefined);
      const lock = await client.getMailboxLock(this.env.IMAP_MAILBOX);
      try {
        const uids = (await client.search({ seen: false }, { uid: true })) || [];
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          try {
            const r = await this.mail.ingest(msg.source, 'imap', null);
            this.log.log(`წერილი: ${r.status}${r.duplicate ? ' (დუბლიკატი)' : ''}, ფაილი ${r.files.length}`);
            await client.messageMove(String(uid), done, { uid: true });
            n++;
          } catch (e) { this.log.error(`წერილის დამუშავება: ${(e as Error).message}`); }   // რჩება წაუკითხავად — შემდეგ ციკლში ხელახლა
        }
      } finally { lock.release(); }
      await client.logout();
      await this.db.updateTable('lab_ext_mail_state').set({ checked_at: sql`now()`, ok: true, error: null, processed_total: sql`processed_total + ${n}` }).where('id', '=', 1).execute();
    } catch (e) {
      this.log.error(`IMAP: ${(e as Error).message}`);
      await this.db.updateTable('lab_ext_mail_state').set({ checked_at: sql`now()`, ok: false, error: (e as Error).message.slice(0, 500) }).where('id', '=', 1).execute().catch(() => undefined);
      client.close();
    } finally { this.busy = false; }
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
}

class AssignDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('4', { each: true }) item_ids: string[] }
class ReasonDto { @IsString() @Length(3, 500) reason: string }

@Controller('lab/external/mail')
export class LabMailController {
  constructor(private readonly svc: LabMailService) {}
  @Get() @Roles(...LAB_STAFF) list(@Query('open') open?: string) { return this.svc.list(open === 'true'); }
  @Get('state') @Roles(...LAB_STAFF) state() { return this.svc.state(); }
  /** .eml ხელით (მაგ. Outlook-იდან შენახული) — იგივე დამუშავება, რაც IMAP-ით */
  @Post('upload') @HttpCode(200) @Roles(...LAB_STAFF)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: AuthUser) {
    if (!file?.buffer?.length) throw new BadRequestException('ატვირთეთ .eml ფაილი');
    return this.svc.ingest(file.buffer, 'upload', u);
  }
  /** შემოწმება ცვლილების გარეშე: რას ამოიცნობდა (ლაბორატორიის პარამეტრების მოსარგებად) */
  @Post('test') @HttpCode(200) @Roles(...LAB_STAFF)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } }))
  test(@UploadedFile() file: Express.Multer.File | undefined, @Query('lab_id') labId?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('ატვირთეთ .eml ფაილი');
    return this.svc.test(file.buffer, labId && /^[0-9a-f-]{36}$/i.test(labId) ? labId : undefined);
  }
  @Get('files/:id') @Roles(...LAB_STAFF)
  async file(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.svc.fileStream(id);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(f.stream);
  }
  @Post('files/:id/assign') @HttpCode(200) @Roles(...LAB_STAFF)
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.svc.assign(id, dto.item_ids, u, auditCtx(req)); }
  @Post('files/:id/dismiss') @HttpCode(200) @Roles(...LAB_STAFF)
  dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.svc.dismiss(id, dto.reason, u, auditCtx(req)); }
}
