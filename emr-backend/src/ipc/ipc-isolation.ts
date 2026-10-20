import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { canEndIsolation, INFECTIOUS, IPC_ANY, IPC_DEPT, IPC_FULL, IPC_STATUS_READ, IpcCommon, ISO_REASONS, ISO_TYPES, isoEnd, isoStart, REASON_KA, type Ex } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

class IsolationStartDto {
  @IsIn(ISO_TYPES) type: string;
  @IsIn(ISO_REASONS) reason: string;
  @IsOptional() @IsString() @MaxLength(500) reason_text?: string | null;
  @IsOptional() @IsUUID() flag_id?: string | null;
}
class IsolationEndDto { @IsString() @Length(3, 500) reason: string }

/**
 * იზოლაციის ეპიზოდები (0067): დაყენება / მოხსნა ჰოსპიტალიზაციაზე, ისტორია, კარის ნიშანი (PDF), ინფექციის კონტროლის პაციენტების სია.
 * ვინ: განყოფილების ექიმი / ექთანი / მენეჯერი, მკურნალი ექიმი, admin, ინფექციის კონტროლი (infection — ყველგან, infection_dept — თავის განყოფილებებში).
 * MDRO-ს გამო დადებულს (isolation_remove_mdro = ipc) ხსნის მხოლოდ ინფექციის კონტროლი.
 */
@Injectable()
export class IpcIsolationService {
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  private async stay(encounterId: string, ex: Ex = this.db) {
    const st = await ex.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id')
      .leftJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null))
      .leftJoin('beds as b', 'b.id', 'a.bed_id').leftJoin('wards as w', 'w.id', 'b.ward_id').leftJoin('departments as d', 'd.id', 'a.department_id')
      .select(['st.encounter_id', 'st.patient_id', 'st.adm_no', 'st.status', 'e.attending_doctor_id', 'a.department_id', 'd.name as department', 'b.code as bed_code', 'w.code as ward_code', 'w.id as ward_id'])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    return st;
  }
  /** იზოლაციის დაყენება / მოხსნა: admin, მკურნალი ექიმი, განყოფილების ექიმი / ექთანი / მენეჯერი, ინფექციის კონტროლი */
  private async canEdit(u: AuthUser, st: { department_id: string | null; attending_doctor_id: string | null }, ex: Ex = this.db) {
    if (has(u, 'admin', ...IPC_FULL) || st.attending_doctor_id === u.id) return true;
    if (!st.department_id) return false;
    if (has(u, 'doctor', 'nurse', 'manager')) {
      const me = await ex.selectFrom('users').select('department_id').where('id', '=', u.id).executeTakeFirst();
      if (me?.department_id === st.department_id) return true;
    }
    return has(u, ...IPC_DEPT) && (await this.c.userDepts(u.id, ex)).includes(st.department_id);
  }

  async forStay(encounterId: string, u: AuthUser) {
    const st = await this.stay(encounterId);
    const r = await this.c.rulesOrNull();
    const rows = await this.db.selectFrom('ipc_isolations as i').innerJoin('ipc_isolation_types as t', 't.code', 'i.type')
      .leftJoin('users as su', 'su.id', 'i.started_by').leftJoin('users as eu', 'eu.id', 'i.ended_by').leftJoin('ipc_patient_flags as f', 'f.id', 'i.flag_id')
      .select(['i.id', 'i.type', 't.name', 't.short_name', 't.color', 'i.reason', 'i.reason_text', 'i.flag_id', 'f.mdro_code', 'i.started_at', 'i.ended_at', 'i.end_reason', 'i.auto_ended',
        sql<string | null>`su.first_name || ' ' || su.last_name`.as('started_by_name'), sql<string | null>`eu.first_name || ' ' || eu.last_name`.as('ended_by_name'),
        sql<number>`((coalesce(i.ended_at, now()) AT TIME ZONE ${TZ})::date - (i.started_at AT TIME ZONE ${TZ})::date + 1)::int`.as('days')])
      .where('i.encounter_id', '=', encounterId).orderBy('i.started_at', 'desc').execute();
    const edit = st.status === 'active' && await this.canEdit(u, st);
    return { encounter_id: encounterId, status: st.status, active: rows.filter((x) => !x.ended_at), history: rows.filter((x) => !!x.ended_at),
      can: { edit, end_mdro: edit && canEndIsolation(u, { reason: 'mdro' }, r) }, door_sign: r ? r.door_sign : true, module: !!r };
  }

  async start(encounterId: string, d: IsolationStartDto, u: AuthUser, req: Request) {
    const r = await this.c.rulesOrNull();
    if (d.reason === 'mdro' && !d.flag_id) throw new BadRequestException({ code: 'FLAG_REQUIRED', message: 'მიზეზი „MDRO“ — მიუთითეთ ფლაგი' });
    if (['other', 'suspected', 'confirmed'].includes(d.reason) && (d.reason_text?.trim().length ?? 0) < 2) throw new BadRequestException({ code: 'REASON_TEXT', message: 'მიუთითეთ მიზეზი / ინფექცია' });
    const res = await this.db.transaction().execute(async (trx) => {
      await trx.selectFrom('inpatient_stays').select('encounter_id').where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
      const st = await this.stay(encounterId, trx);
      if (st.status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
      if (!(await this.canEdit(u, st, trx))) throw new ForbiddenException('იზოლაციას აყენებს განყოფილების ექიმი / ექთანი, მკურნალი ექიმი ან ინფექციის კონტროლი');
      if (d.flag_id) {
        if (!r) throw new BadRequestException({ code: 'MODULE_DISABLED', message: 'ინფექციის კონტროლის მოდული გამორთულია — MDRO ფლაგი მიუწვდომელია' });
        const f = await trx.selectFrom('ipc_patient_flags').select(['id', 'patient_id', 'status']).where('id', '=', d.flag_id).executeTakeFirst();
        if (!f || f.patient_id !== st.patient_id || f.status !== 'active') throw new BadRequestException({ code: 'FLAG', message: 'MDRO ფლაგი ვერ მოიძებნა ან აქტიური არ არის' });
      }
      const row = await isoStart(trx, { encounterId, patientId: st.patient_id, type: d.type, reason: d.flag_id ? 'mdro' : d.reason, reasonText: d.reason_text, flagId: d.flag_id ?? null, userId: u.id });
      await trx.insertInto('inpatient_events').values({ encounter_id: encounterId, kind: 'isolation', user_id: u.id,
        data: JSON.stringify({ action: 'start', type: d.type, reason: REASON_KA[row.reason], text: row.reason_text }) }).execute();
      await this.audit.log(auditCtx(req), { action: 'IPC_ISOLATION_START', entityName: 'ipc_isolations', entityId: row.id, newData: { encounter_id: encounterId, ...d } }, trx);
      // მრავალსაწოლიან პალატაში სხვა პაციენტებიც არიან → გაფრთხილება (გადაყვანა / კოჰორტა)
      const warnings: string[] = [];
      if (st.ward_id) {
        const n = await trx.selectFrom('bed_assignments as a').innerJoin('beds as b', 'b.id', 'a.bed_id').select(sql<number>`count(*)::int`.as('n'))
          .where('b.ward_id', '=', st.ward_id).where('a.ended_at', 'is', null).where('a.encounter_id', '<>', encounterId).executeTakeFirstOrThrow();
        const capable = await trx.selectFrom('wards').select('isolation_capable').where('id', '=', st.ward_id).executeTakeFirstOrThrow();
        if (n.n > 0 && (INFECTIOUS.includes(d.type) || d.type === 'protective')) warnings.push(`პალატაში ${st.ward_code} კიდევ ${n.n} პაციენტია — განიხილეთ გადაყვანა იზოლატორში ან კოჰორტირება`);
        if (!capable.isolation_capable) warnings.push(`პალატა ${st.ward_code} იზოლაციისთვის არ არის მონიშნული`);
      }
      return { id: row.id, warnings };
    });
    return { ...res, ...(await this.forStay(encounterId, u)) };
  }

  async end(id: string, d: IsolationEndDto, u: AuthUser, req: Request) {
    const r = await this.c.rulesOrNull();
    const enc = await this.db.transaction().execute(async (trx) => {
      const iso = await trx.selectFrom('ipc_isolations').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!iso) throw new NotFoundException('იზოლაცია ვერ მოიძებნა');
      if (iso.ended_at) throw new ConflictException({ code: 'ENDED', message: 'იზოლაცია უკვე მოხსნილია' });
      const st = await this.stay(iso.encounter_id, trx);
      if (!(await this.canEdit(u, st, trx))) throw new ForbiddenException('იზოლაციას ხსნის განყოფილების ექიმი / ექთანი, მკურნალი ექიმი ან ინფექციის კონტროლი');
      if (!canEndIsolation(u, iso, r)) throw new ForbiddenException({ code: 'IPC_ONLY', message: 'იზოლაცია MDRO-ს გამოა — მოხსნის ინფექციის კონტროლი' });
      await isoEnd(trx, id, u.id, d.reason);
      await trx.insertInto('inpatient_events').values({ encounter_id: iso.encounter_id, kind: 'isolation', user_id: u.id,
        data: JSON.stringify({ action: 'end', type: iso.type, reason: d.reason.trim() }) }).execute();
      await this.audit.log(auditCtx(req), { action: 'IPC_ISOLATION_END', entityName: 'ipc_isolations', entityId: id, oldData: { type: iso.type, reason: iso.reason }, newData: d }, trx);
      return iso.encounter_id;
    });
    return this.forStay(enc, u);
  }

  /** კარის ნიშანი — A4: ყველა აქტიური ტიპი, PPE, ინსტრუქცია; პაციენტის სახელი / დიაგნოზი / მიკროორგანიზმი — არა */
  async doorSign(encounterId: string): Promise<Buffer> {
    const r = await this.c.rulesOrNull();
    if (r && !r.door_sign) throw new ForbiddenException({ code: 'DISABLED', message: 'კარის ნიშანი გამორთულია (მოდულები → ინფექციის კონტროლი)' });
    const st = await this.stay(encounterId);
    const types = await this.db.selectFrom('ipc_isolations as i').innerJoin('ipc_isolation_types as t', 't.code', 'i.type')
      .select(['t.code', 't.name', 't.color', 't.ppe', 't.door_text', 'i.started_at']).where('i.encounter_id', '=', encounterId).where('i.ended_at', 'is', null)
      .orderBy('t.priority', 'desc').execute();
    if (!types.length) throw new ConflictException({ code: 'NO_ISOLATION', message: 'აქტიური იზოლაცია არ არის' });
    const clinic = await this.db.selectFrom('clinic_settings').select('name').executeTakeFirst();
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 44, right: 44 }, info: { Title: 'იზოლაცია — კარის ნიშანი', Author: clinic?.name ?? '' } });
    doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (x: Buffer) => chunks.push(x));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
    const top = types[0];
    doc.rect(0, 0, doc.page.width, 150).fill(top.color);
    doc.fillColor('#FFFFFF').font('B').fontSize(16).text('ყურადღება — იზოლაცია', L, 34, { width: W, align: 'center' });
    doc.font('B').fontSize(types.length > 1 ? 26 : 34).text(types.map((t) => t.name.toUpperCase()).join(' + '), L, 62, { width: W, align: 'center' });
    doc.fillColor('black').font('R').fontSize(12).text('ოთახში შესვლამდე მიმართეთ ექთანს', L, 166, { width: W, align: 'center' });
    doc.y = 196;
    for (const t of types) {
      doc.moveDown(0.6);
      doc.rect(L, doc.y, 8, 22).fill(t.color); doc.fillColor('black').font('B').fontSize(15).text(t.name, L + 16, doc.y + 2, { width: W - 16 });
      doc.moveDown(0.3);
      const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
      if (t.ppe.trim()) {
        doc.font('B').fontSize(12).text('დამცავი აღჭურვილობა:', L, doc.y, { width: W });
        for (const x of lines(t.ppe)) doc.font('R').fontSize(13).text(`–  ${x}`, L + 10, doc.y + 2, { width: W - 10 });
      }
      if (t.door_text.trim()) {
        doc.moveDown(0.3); doc.font('B').fontSize(12).text('დამატებით:', L, doc.y, { width: W });
        for (const x of lines(t.door_text)) doc.font('R').fontSize(12).text(`–  ${x}`, L + 10, doc.y + 2, { width: W - 10 });
      }
    }
    doc.moveDown(1.2);
    doc.font('B').fontSize(14).text('ხელის ჰიგიენა — ოთახში შესვლამდე და გამოსვლისას', L, doc.y, { width: W, align: 'center' });
    const since = new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(String(types[types.length - 1].started_at)));
    doc.font('R').fontSize(9).fillColor('#555').text(`${clinic?.name ?? ''} · ${st.department ?? ''}${st.ward_code ? ` · პალატა ${st.ward_code}` : ''}${st.bed_code ? ` · საწოლი ${st.bed_code}` : ''} · იზოლაცია ${since}-დან`,
      L, doc.page.height - doc.page.margins.bottom - 14, { width: W, align: 'center', lineBreak: false });
    doc.end();
    return done;
  }

  /** ინფექციის კონტროლის სია: აქტიური ჰოსპიტალიზაციები იზოლაციით ან MDRO ფლაგით (infection — ყველა, infection_dept — თავისი განყოფილებები) */
  async patients(u: AuthUser, departmentId?: string) {
    await this.c.rules();
    const sc = await this.c.scope(u);
    let q = this.db.selectFrom('inpatient_stays as st').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null))
      .innerJoin('departments as d', 'd.id', 'a.department_id').leftJoin('beds as b', 'b.id', 'a.bed_id').leftJoin('wards as w', 'w.id', 'b.ward_id')
      .select(['st.encounter_id', 'st.adm_no', 'st.admitted_at', 'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'p.personal_number',
        'a.department_id', 'd.name as department', 'b.code as bed_code', 'w.code as ward_code', 'w.isolation_capable',
        sql<number>`((now() AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date + 1)::int`.as('day'),
        sql<{ id: string; type: string; reason: string; started_at: string; flag_id: string | null }[]>`(SELECT coalesce(json_agg(json_build_object('id', i.id, 'type', i.type, 'reason', i.reason,
          'started_at', i.started_at, 'flag_id', i.flag_id) ORDER BY t.priority DESC), '[]'::json) FROM ipc_isolations i JOIN ipc_isolation_types t ON t.code = i.type
          WHERE i.encounter_id = st.encounter_id AND i.ended_at IS NULL)`.as('isolations'),
        sql<{ id: string; mdro_code: string; status: string; isolation_type: string; onset: string | null; reviewed: boolean }[]>`(SELECT coalesce(json_agg(json_build_object('id', f.id,
          'mdro_code', f.mdro_code, 'status', f.status, 'isolation_type', t.isolation_type, 'onset', f.onset, 'reviewed', f.reviewed_at IS NOT NULL) ORDER BY t.sort_order), '[]'::json)
          FROM ipc_patient_flags f JOIN ipc_mdro_types t ON t.code = f.mdro_code WHERE f.patient_id = st.patient_id AND f.status IN ('active', 'suggested'))`.as('flags'),
        sql<number>`(SELECT count(*)::int FROM bed_assignments a2 JOIN beds b2 ON b2.id = a2.bed_id WHERE b2.ward_id = b.ward_id AND a2.ended_at IS NULL AND a2.encounter_id <> st.encounter_id)`.as('ward_others')])
      .where('st.status', '=', 'active')
      .where((eb) => eb.or([
        eb.exists(eb.selectFrom('ipc_isolations as i').select('i.id').whereRef('i.encounter_id', '=', 'st.encounter_id').where('i.ended_at', 'is', null)),
        eb.exists(eb.selectFrom('ipc_patient_flags as f').select('f.id').whereRef('f.patient_id', '=', 'st.patient_id').where('f.status', 'in', ['active', 'suggested'])),
      ]))
      .orderBy('d.name').orderBy('b.code');
    if (departmentId) q = q.where('a.department_id', '=', departmentId);
    if (!sc.full) q = q.where('a.department_id', 'in', sc.depts);
    const rows = await q.execute();
    return rows.map((x) => {
      const missing = x.flags.filter((f) => f.status === 'active' && !x.isolations.some((i) => i.type === f.isolation_type || (f.isolation_type === 'contact' && i.type === 'contact_plus')));
      return { ...x, missing_isolation: missing.map((f) => f.isolation_type), shared_ward: x.ward_others > 0 && (x.isolations.some((i) => INFECTIOUS.includes(i.type)) || x.flags.some((f) => f.status === 'active')) };
    });
  }
}

@Controller('ipc')
export class IpcIsolationController {
  constructor(private readonly s: IpcIsolationService) {}
  @Get('stays/:id/isolations') @Roles(...IPC_STATUS_READ) forStay(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.forStay(id, u); }
  @Post('stays/:id/isolations') @Roles('admin', 'doctor', 'nurse', 'manager', ...IPC_ANY)
  start(@Param('id', ParseUUIDPipe) id: string, @Body() d: IsolationStartDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.start(id, d, u, r); }
  @Post('isolations/:id/end') @HttpCode(200) @Roles('admin', 'doctor', 'nurse', 'manager', ...IPC_ANY)
  end(@Param('id', ParseUUIDPipe) id: string, @Body() d: IsolationEndDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.end(id, d, u, r); }
  @Get('stays/:id/door-sign') @Roles(...IPC_STATUS_READ)
  async door(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const buf = await this.s.doorSign(id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="isolation-sign.pdf"' });
    return new StreamableFile(buf);
  }
  @Get('patients') @Roles(...IPC_ANY) patients(@CurrentUser() u: AuthUser, @Query('department_id') department_id?: string) { return this.s.patients(u, department_id); }
}

