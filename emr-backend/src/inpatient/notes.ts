import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param,
  ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ArrayMaxSize } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { InpatientModule, InpatientService } from './inpatient';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;
const KINDS = ['admission', 'progress', 'rounds', 'consult', 'icu_daily', 'icu_out'] as const;
/** დღიურად ითვლება (0047: ICU დღიურიც) */
export const DAILY_KINDS = ['progress', 'icu_daily'];
type Kind = (typeof KINDS)[number];
const MAX = 20_000;

/** ველები ჩანაწერის სახის მიხედვით (required — ხელმოწერისთვის) */
export const NOTE_FIELDS: Record<Kind, { key: string; label: string; required?: boolean }[]> = {
  admission: [
    { key: 'complaints', label: 'ჩივილები', required: true }, { key: 'anamnesis_morbi', label: 'დაავადების ანამნეზი' },
    { key: 'anamnesis_vitae', label: 'ცხოვრების ანამნეზი / გადატანილი დაავადებები' }, { key: 'objective', label: 'ობიექტური სტატუსი', required: true },
    { key: 'preliminary_dx', label: 'წინასწარი დიაგნოზი' }, { key: 'plan', label: 'გამოკვლევისა და მკურნალობის გეგმა', required: true },
  ],
  progress: [
    { key: 's', label: 'S — ჩივილები / სუბიექტური' }, { key: 'o', label: 'O — ობიექტური მონაცემები' },
    { key: 'a', label: 'A — შეფასება', required: true }, { key: 'p', label: 'P — გეგმა' },
  ],
  rounds: [{ key: 'findings', label: 'შემოვლის დასკვნა', required: true }, { key: 'recommendations', label: 'რეკომენდაციები' }],
  consult: [{ key: 'assessment', label: 'შეფასება / დასკვნა', required: true }, { key: 'recommendations', label: 'რეკომენდაციები', required: true }],
  // 0047: რეანიმაცია — დღიური სისტემების მიხედვით (A–F) და გაყვანის შეჯამება მიმღები განყოფილებისთვის
  icu_daily: [
    { key: 'a_airway', label: 'A — სასუნთქი გზები' }, { key: 'b_breathing', label: 'B — სუნთქვა / ვენტილაცია' },
    { key: 'c_circulation', label: 'C — ცირკულაცია / ჰემოდინამიკა' }, { key: 'd_disability', label: 'D — ნევროლოგია / სედაცია' },
    { key: 'e_exposure', label: 'E — კანი, ხაზები, ინფექცია, ტემპერატურა' }, { key: 'f_fluids', label: 'F — სითხეები, თირკმელი, ელექტროლიტები, კვება' },
    { key: 'assessment', label: 'შეფასება', required: true }, { key: 'plan', label: 'გეგმა' },
  ],
  icu_out: [
    { key: 'course', label: 'მიმდინარეობა რეანიმაციაში', required: true }, { key: 'procedures', label: 'ჩატარებული (ვენტილაცია, ხაზები, ინფუზიები)' },
    { key: 'condition', label: 'მდგომარეობა გადაყვანისას', required: true }, { key: 'recommendations', label: 'რეკომენდაციები მიმღებ განყოფილებას', required: true },
  ],
};
export const KIND_KA: Record<Kind, string> = { admission: 'მიმღები გასინჯვა', progress: 'დღიური', rounds: 'შემოვლა', consult: 'კონსულტაცია', icu_daily: 'ICU დღიური', icu_out: 'რეანიმაციიდან გაყვანის შეჯამება' };
const URGENCY_KA: Record<string, string> = { routine: 'გეგმიური', urgent: 'სასწრაფო', emergency: 'გადაუდებელი' };

// ================================================================= DTO
export class NoteCreateDto {
  @IsIn(KINDS) kind: Kind;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) note_date?: string;
  @IsOptional() @IsObject() content?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) participants?: string[];
  @IsOptional() @IsUUID() consultation_id?: string;
  @IsOptional() @IsBoolean() sign?: boolean;
}
export class NoteUpdateDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) note_date?: string;
  @IsOptional() @IsObject() content?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) participants?: string[];
}
export class ReasonDto { @IsString() @Length(3, 1000) reason: string }
export class ConsultDto {
  @IsOptional() @IsUUID() target_department_id?: string;
  @IsOptional() @IsUUID() target_doctor_id?: string;
  @IsIn(['routine', 'urgent', 'emergency']) urgency: 'routine' | 'urgent' | 'emergency';
  @IsString() @Length(3, 4000) question: string;
}
export class NoteTemplateDto {
  @IsIn(KINDS) kind: Kind;
  @IsString() @Length(2, 200) name: string;
  @IsObject() content: Record<string, string>;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

/**
 * ექიმის ჩანაწერები (0045): მიმღები გასინჯვა, დღიური (SOAP), შემოვლა, კონსულტაციის პასუხი.
 *   შავი ვერსია (ხედავს ავტორი) → ხელმოწერა (იბლოკება); შესწორება — ახალი ვერსია მიზეზით, წინა superseded.
 *   წერს: მკურნალი ექიმი / მიმდინარე განყოფილების ექიმი (admin); კონსულტაციის პასუხი — სამიზნე ექიმი / განყოფილების ექიმი.
 *   გაწერილზე — დოკუმენტაციის დახურვამდე (closed_at) შეიძლება.
 */
@Injectable()
export class NotesService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly bell: NotificationsService) {}

  // ---------------------------------------------------------------- საერთო
  async stay(encounterId: string, ex: Ex = this.db) {
    const st = await ex.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .select(['st.encounter_id', 'st.patient_id', 'st.status', 'st.adm_no', 'st.admitted_at', 'st.ended_at', 'st.closed_at', 'e.attending_doctor_id', 'p.first_name', 'p.last_name',
        sql<string>`coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT 1), e.department_id)`.as('department_id'),
        sql<string>`to_char(st.admitted_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD')`.as('admitted_day'),
        sql<string>`to_char(coalesce(st.ended_at, now()) AT TIME ZONE ${TZ}, 'YYYY-MM-DD')`.as('last_day')])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    return st;
  }
  private open(st: { status: string; closed_at: string | Date | null }) {
    if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
    if (st.status !== 'active' && st.closed_at) throw new ConflictException('შემთხვევის დოკუმენტაცია დახურულია');
  }
  async canWrite(u: AuthUser, st: { attending_doctor_id: string | null; department_id: string }, ex: Ex = this.db) {
    if (has(u, 'admin')) return true;
    if (!has(u, 'doctor')) return false;
    if (st.attending_doctor_id === u.id) return true;
    return (await this.ipd.me(u, ex)).department_id === st.department_id;
  }
  private async isHeadDoctor(u: AuthUser, departmentId: string, ex: Ex = this.db) {
    if (!has(u, 'doctor')) return false;
    const me = await this.ipd.me(u, ex);
    return me.is_section_head && me.department_id === departmentId;
  }
  private async canAnswer(u: AuthUser, c: { target_doctor_id: string | null; target_department_id: string | null }, ex: Ex = this.db) {
    if (has(u, 'admin')) return true;
    if (!has(u, 'doctor')) return false;
    if (c.target_doctor_id) return c.target_doctor_id === u.id;
    return (await this.ipd.me(u, ex)).department_id === c.target_department_id;
  }
  private clean(kind: Kind, content: Record<string, string> | undefined) {
    const out: Record<string, string> = {};
    const keys = NOTE_FIELDS[kind].map((f) => f.key);
    for (const [k, v] of Object.entries(content ?? {})) {
      if (!keys.includes(k)) throw new BadRequestException(`უცნობი ველი: ${k}`);
      if (typeof v !== 'string') throw new BadRequestException(`ველი ${k} — ტექსტი`);
      if (v.length > MAX) throw new BadRequestException(`ველი ${k} ძალიან გრძელია`);
      out[k] = v;
    }
    return out;
  }
  private async today(ex: Ex = this.db) {
    return (await sql<{ d: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d;
  }
  private base(ex: Ex = this.db) {
    return ex.selectFrom('doctor_notes as n').leftJoin('users as a', 'a.id', 'n.author_id').leftJoin('departments as d', 'd.id', 'n.department_id')
      .selectAll('n').select(['d.name as department_name', sql<string>`a.last_name || ' ' || a.first_name`.as('author_name'), 'a.specialty as author_specialty',
        sql<string[]>`ARRAY(SELECT x.last_name || ' ' || x.first_name FROM users x WHERE x.id = ANY(n.participants) ORDER BY x.last_name)`.as('participant_names'),
        sql<string>`to_char(n.note_date, 'YYYY-MM-DD')`.as('day')]);
  }
  get(id: string, ex: Ex = this.db) { return this.base(ex).where('n.id', '=', id).executeTakeFirst(); }
  private async notifyIds(ids: (string | null | undefined)[], n: { kind: string; title: string; body?: string; item?: string; entityId: string; link: string; urgent?: boolean }, except?: string) {
    for (const id of new Set(ids.filter((x): x is string => !!x))) if (id !== except) await this.bell.notify(id, { ...n, urgent: !!n.urgent }).catch(() => undefined);
  }
  private async doctorsOf(departmentId: string) {
    return (await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').distinct().where('u.is_active', '=', true)
      .where('u.department_id', '=', departmentId).where(sql<boolean>`c.capabilities && ARRAY['doctor']::varchar[]`).execute()).map((r) => r.id);
  }

  // ---------------------------------------------------------------- ჩანაწერები
  async create(encounterId: string, dto: NoteCreateDto, u: AuthUser, ctx: AuditContext) {
    const content = this.clean(dto.kind, dto.content);
    const id = await this.db.transaction().execute(async (trx) => {
      const st = await this.stay(encounterId, trx);
      this.open(st);
      let consult: { id: string; status: string; target_doctor_id: string | null; target_department_id: string | null; encounter_id: string } | undefined;
      if (dto.kind === 'consult') {
        if (!dto.consultation_id) throw new BadRequestException('კონსულტაციის პასუხი — მიუთითეთ მოთხოვნა');
        consult = await trx.selectFrom('consultations').select(['id', 'status', 'target_doctor_id', 'target_department_id', 'encounter_id']).where('id', '=', dto.consultation_id).forUpdate().executeTakeFirst();
        if (!consult || consult.encounter_id !== encounterId) throw new NotFoundException('კონსულტაცია ვერ მოიძებნა');
        if (consult.status !== 'requested') throw new ConflictException('კონსულტაცია უკვე დასრულებულია / გაუქმებულია');
        if (!(await this.canAnswer(u, consult, trx))) throw new ForbiddenException('პასუხს წერს კონსულტანტი (მითითებული ექიმი / განყოფილების ექიმი)');
      } else {
        if (dto.consultation_id) throw new BadRequestException('consultation_id — მხოლოდ კონსულტაციის პასუხზე');
        if (!(await this.canWrite(u, st, trx))) throw new ForbiddenException('ჩანაწერს წერს მკურნალი ან განყოფილების ექიმი');
      }
      if (dto.kind === 'rounds' && !(await this.isHeadDoctor(u, st.department_id, trx)) && !has(u, 'admin') && !(dto.participants?.length)) {
        throw new BadRequestException('შემოვლა: მიუთითეთ მონაწილეები (ან ჩაწერს განყოფილების ხელმძღვანელი)');
      }
      if (dto.kind === 'admission') {
        const ex = await trx.selectFrom('doctor_notes').select('id').where('encounter_id', '=', encounterId).where('kind', '=', 'admission')
          .where('status', '=', 'signed').where('superseded_at', 'is', null).executeTakeFirst();
        if (ex) throw new ConflictException({ code: 'ADMISSION_NOTE_EXISTS', message: 'მიმღები გასინჯვა უკვე ხელმოწერილია — გამოიყენეთ შესწორება', note_id: ex.id });
      }
      const day = dto.note_date ?? await this.today(trx);
      if (day < st.admitted_day || day > st.last_day) throw new BadRequestException('თარიღი ჰოსპიტალიზაციის პერიოდის გარეთაა');
      if (dto.participants?.length) {
        const n = await trx.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', dto.participants).where('is_active', '=', true).executeTakeFirstOrThrow();
        if (n.n !== new Set(dto.participants).size) throw new BadRequestException('მონაწილე ვერ მოიძებნა');
      }
      const r = await trx.insertInto('doctor_notes').values({ encounter_id: encounterId, patient_id: st.patient_id, department_id: dto.kind === 'consult' ? consult!.target_department_id ?? null : st.department_id,
        kind: dto.kind, note_date: day, consultation_id: dto.consultation_id ?? null, content: JSON.stringify(content), participants: dto.participants ?? [], author_id: u.id })
        .returning('id').executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'NOTE_DRAFT', entityName: 'doctor_notes', entityId: r.id, newData: { kind: dto.kind, encounter_id: encounterId } }, trx);
      return r.id;
    });
    return dto.sign ? this.sign(id, u, ctx) : this.get(id);
  }

  async update(id: string, dto: NoteUpdateDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('doctor_notes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!n) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (n.author_id !== u.id) throw new ForbiddenException('შავ ვერსიას ასწორებს მხოლოდ ავტორი');
      if (n.status !== 'draft') throw new ConflictException('ხელმოწერილი ჩანაწერი არ რედაქტირდება — შესწორება');
      const st = await this.stay(n.encounter_id, trx);
      if (dto.note_date && (dto.note_date < st.admitted_day || dto.note_date > st.last_day)) throw new BadRequestException('თარიღი ჰოსპიტალიზაციის პერიოდის გარეთაა');
      await trx.updateTable('doctor_notes').set({ ...(dto.content && { content: JSON.stringify(this.clean(n.kind as Kind, dto.content)) }),
        ...(dto.note_date && !n.amends_id && { note_date: dto.note_date }), ...(dto.participants && { participants: dto.participants }) }).where('id', '=', id).execute();
      void ctx;
      return this.get(id, trx);
    });
  }

  async discard(id: string, u: AuthUser, ctx: AuditContext) {
    const n = await this.db.selectFrom('doctor_notes').select(['id', 'author_id', 'status']).where('id', '=', id).executeTakeFirst();
    if (!n) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    if (n.author_id !== u.id || n.status !== 'draft') throw new ForbiddenException('იშლება მხოლოდ საკუთარი შავი ვერსია');
    await this.db.deleteFrom('doctor_notes').where('id', '=', id).execute();
    await this.audit.log(ctx, { action: 'NOTE_DISCARD', entityName: 'doctor_notes', entityId: id });
    return { id, deleted: true };
  }

  async sign(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    const res = await this.db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('doctor_notes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!n) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (n.author_id !== u.id) throw new ForbiddenException('ხელს აწერს ავტორი');
      if (n.status !== 'draft') throw new ConflictException('უკვე ხელმოწერილია');
      const st = await this.stay(n.encounter_id, trx);
      this.open(st);
      const content = n.content as Record<string, string>;
      const miss = NOTE_FIELDS[n.kind as Kind].filter((f) => f.required && !(content[f.key] ?? '').trim()).map((f) => f.label);
      if (miss.length) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: `შეავსეთ: ${miss.join(', ')}`, fields: miss });
      if (n.amends_id) {
        const old = await trx.selectFrom('doctor_notes').select(['id', 'status', 'superseded_at']).where('id', '=', n.amends_id).forUpdate().executeTakeFirstOrThrow();
        if (old.superseded_at) throw new ConflictException('ეს ვერსია უკვე შესწორებულია');
        await trx.updateTable('doctor_notes').set({ superseded_at: sql`now()` }).where('id', '=', old.id).execute();
      }
      try {
        await trx.updateTable('doctor_notes').set({ status: 'signed', signed_at: sql`now()` }).where('id', '=', id).execute();
      } catch (e) { mapPgError(e, { ux_dn_admission: 'მიმღები გასინჯვა უკვე ხელმოწერილია — გამოიყენეთ შესწორება' }); }
      await this.ipd.event(trx, { encounter_id: n.encounter_id, kind: n.amends_id ? 'note_amended' : 'note_signed', data: { note_id: id, kind: n.kind, version: n.version, reason: n.amend_reason } }, u);
      let billed: { amount: string; tariff: string } | null = null; let warning: string | null = null;
      let consult: { id: string; requested_by: string; urgency: string } | null = null;
      if (n.kind === 'consult' && !n.amends_id) {
        const c = await trx.selectFrom('consultations').select(['id', 'requested_by', 'urgency', 'status']).where('id', '=', n.consultation_id!).forUpdate().executeTakeFirstOrThrow();
        if (c.status !== 'requested') throw new ConflictException('კონსულტაცია უკვე დასრულებულია / გაუქმებულია');
        consult = c;
        await trx.updateTable('consultations').set({ status: 'answered', answered_by: u.id, answered_at: sql`now()`, answer_note_id: id }).where('id', '=', c.id).execute();
        await this.ipd.event(trx, { encounter_id: n.encounter_id, kind: 'consult_answered', data: { consultation_id: c.id, note_id: id } }, u);
        if (s.consult_billing !== false) {
          const t = await trx.selectFrom('users as x').leftJoin('service_tariffs as t', (j) => j.onRef('t.id', '=', 'x.consultation_tariff_id').on('t.is_active', '=', true))
            .select(['t.id', 't.title', 't.base_price']).where('x.id', '=', u.id).executeTakeFirst();
          const inv = await trx.selectFrom('invoices').select('id').where('encounter_id', '=', n.encounter_id).forUpdate().executeTakeFirst();
          if (t?.id && t.base_price !== null && inv) {
            await trx.insertInto('invoice_line_items').values({ invoice_id: inv.id, tariff_id: t.id, consultation_id: c.id, description: `${t.title} (სტაციონარში კონსულტაცია)`,
              quantity: 1, unit_price: t.base_price, original_price: t.base_price }).execute();
            billed = { amount: t.base_price, tariff: t.title ?? '' };
          } else warning = !t?.id ? 'კონსულტანტს კონსულტაციის ტარიფი არ აქვს — ინვოისში არ დაემატა' : 'ვიზიტს ინვოისი არ აქვს';
        }
      }
      await this.audit.log(ctx, { action: n.amends_id ? 'NOTE_AMEND' : 'NOTE_SIGN', entityName: 'doctor_notes', entityId: id,
        newData: { kind: n.kind, version: n.version, amends: n.amends_id, reason: n.amend_reason, billed } }, trx);
      return { n, st, consult, billed, warning };
    });
    if (res.consult) {
      await this.notifyIds([res.consult.requested_by, res.st.attending_doctor_id], { kind: 'ipd_consult_done', title: `კონსულტაცია: პასუხი მზადაა`,
        body: `${res.st.last_name} ${res.st.first_name} (${res.st.adm_no})`, item: res.st.adm_no, entityId: res.n.encounter_id,
        link: `/inpatient/stay/${res.n.encounter_id}#notes`, urgent: res.consult.urgency !== 'routine' }, u.id);
    }
    // 0047: რეანიმაციიდან გაყვანის შეჯამება → მკურნალ ექიმს და მიმღები განყოფილების ექიმებს
    if (res.n.kind === 'icu_out' && !res.n.amends_id) {
      const ep = await this.db.selectFrom('icu_episodes').select(['exit_department_id']).where('encounter_id', '=', res.n.encounter_id).orderBy('started_at', 'desc').limit(1).executeTakeFirst();
      const tr = await this.db.selectFrom('inpatient_transfers').select('to_department_id').where('encounter_id', '=', res.n.encounter_id).where('status', '=', 'requested').executeTakeFirst();
      const deps = [ep?.exit_department_id, tr?.to_department_id, res.st.department_id].filter((x): x is string => !!x && x !== res.n.department_id);
      const docs = deps.length ? (await this.db.selectFrom('users as x').innerJoin('user_capabilities as c', 'c.user_id', 'x.id').select('x.id').distinct()
        .where('x.is_active', '=', true).where('x.department_id', 'in', deps).where(sql<boolean>`'doctor' = ANY(c.capabilities)`).execute()).map((r) => r.id) : [];
      await this.notifyIds([res.st.attending_doctor_id, ...docs], { kind: 'icu_out_note', title: 'რეანიმაციიდან გაყვანის შეჯამება', body: `${res.st.last_name} ${res.st.first_name} (${res.st.adm_no})`,
        item: res.st.adm_no, entityId: res.n.encounter_id, link: `/inpatient/stay/${res.n.encounter_id}#notes` }, u.id);
    }
    return { ...(await this.get(id))!, billed: res.billed, warning: res.warning };
  }

  async amend(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('doctor_notes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!n) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (n.status !== 'signed' || n.superseded_at) throw new ConflictException('შესწორდება მხოლოდ მოქმედი ხელმოწერილი ვერსია');
      const st = await this.stay(n.encounter_id, trx);
      this.open(st);
      const ok = n.author_id === u.id || has(u, 'admin') || (n.kind !== 'consult' && (st.attending_doctor_id === u.id || await this.isHeadDoctor(u, st.department_id, trx)));
      if (!ok) throw new ForbiddenException('ასწორებს ავტორი, მკურნალი ექიმი ან განყოფილების ხელმძღვანელი');
      try {
        const r = await trx.insertInto('doctor_notes').values({ encounter_id: n.encounter_id, patient_id: n.patient_id, department_id: n.department_id, kind: n.kind, note_date: n.note_date,
          consultation_id: n.consultation_id, content: JSON.stringify(n.content), participants: n.participants, version: n.version + 1, root_id: n.root_id ?? n.id, amends_id: n.id,
          amend_reason: reason.trim(), author_id: u.id }).returning('id').executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'NOTE_AMEND_DRAFT', entityName: 'doctor_notes', entityId: r.id, newData: { amends: id, reason } }, trx);
        return this.get(r.id, trx);
      } catch (e) { mapPgError(e, { ux_dn_amend_draft: 'ამ ჩანაწერის შესწორება უკვე მიმდინარეობს (შავი ვერსია)' }); }
    });
  }

  history(id: string) {
    return this.db.selectFrom('doctor_notes').select(sql<string>`coalesce(root_id, id)`.as('root')).where('id', '=', id).executeTakeFirst().then(async (r) => {
      if (!r) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      return this.base().where(sql<boolean>`coalesce(n.root_id, n.id) = ${r.root}`).where('n.status', '=', 'signed').orderBy('n.version').execute();
    });
  }

  /** ჰოსპიტალიზაციის ჩანაწერები: ხელმოწერილი (მოქმედი + ისტორიის ნიშანი), ჩემი შავი ვერსიები, კონსულტაციები, აკლია */
  async list(encounterId: string, u: AuthUser) {
    const s = await this.ipd.settings();
    const st = await this.stay(encounterId);
    const notes = await this.base().where('n.encounter_id', '=', encounterId)
      .where((eb) => eb.or([eb('n.status', '=', 'signed'), eb('n.author_id', '=', u.id)])).orderBy('n.note_date', 'desc').orderBy('n.created_at', 'desc').execute();
    const consults = await this.consultBase().where('c.encounter_id', '=', encounterId).orderBy('c.created_at', 'desc').execute();
    const today = await this.today();
    const current = notes.filter((n) => n.status === 'signed' && !n.superseded_at);
    const admission = current.find((n) => n.kind === 'admission') ?? null;
    const progressDays = new Set(current.filter((n) => DAILY_KINDS.includes(n.kind)).map((n) => n.day));
    const missing: string[] = [];
    if (s.progress_note_daily !== false) {
      // ჰოსპიტალიზაციის მეორე დღიდან (პირველ დღეს — მიმღები გასინჯვა) გუშინდელამდე (ან გაწერის დღემდე ჩათვლით)
      for (let d = addDay(st.admitted_day, 1); d < (st.status === 'active' ? today : addDay(st.last_day, 1)); d = addDay(d, 1)) if (!progressDays.has(d)) missing.push(d);
    }
    const admissionDue = new Date(new Date(st.admitted_at).getTime() + (s.admission_note_hours ?? 24) * 3_600_000);
    const writable = st.status !== 'cancelled' && !(st.status !== 'active' && st.closed_at);
    return {
      notes, consultations: consults, fields: NOTE_FIELDS, today, admitted_day: st.admitted_day, last_day: st.last_day,
      admission: { note_id: admission?.id ?? null, due_at: admissionDue, overdue: !admission && admissionDue.getTime() < Date.now() },
      missing_days: missing,
      can: { write: writable && await this.canWrite(u, st), head: await this.isHeadDoctor(u, st.department_id), consult: writable && await this.canWrite(u, st) },
    };
  }

  /** „O“ ველში ჩასასმელი ტექსტი: ბოლო ვიტალები / NEWS2, ბალანსი (24 სთ), ლაბ. / კვლევები (24 სთ), აქტიური დანიშნულებები */
  async insertData(encounterId: string) {
    const v = await this.db.selectFrom('encounter_vitals').selectAll().where('encounter_id', '=', encounterId).where('voided_at', 'is', null).orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
    const f = (await sql<{ i: string; o: string }>`SELECT coalesce(sum(volume_ml) FILTER (WHERE direction = 'in'), 0) AS i, coalesce(sum(volume_ml) FILTER (WHERE direction = 'out'), 0) AS o
      FROM fluid_entries WHERE encounter_id = ${encounterId} AND voided_at IS NULL AND recorded_at > now() - interval '24 hours'`.execute(this.db)).rows[0];
    const labs = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as sv', 'sv.id', 'i.service_id').leftJoin('dx_reports as rep', 'rep.order_item_id', 'i.id')
      .select(['i.id', 'i.section', 'sv.name', 'rep.impression', 'i.report_text',
        sql<{ name: string; value_num: string | null; value_text: string | null; unit: string | null; flag: string | null }[]>`coalesce((SELECT json_agg(json_build_object('name', a.name, 'value_num', r.value_num, 'value_text', r.value_text, 'unit', r.unit, 'flag', r.flag) ORDER BY a.sort_order)
          FROM lab_results r JOIN lab_analytes a ON a.id = r.analyte_id WHERE r.order_item_id = i.id), '[]'::json)`.as('results')])
      .where('i.encounter_id', '=', encounterId).where('i.status', '=', 'validated').where('i.validated_at', '>', sql<Date>`now() - interval '24 hours'`).orderBy('i.ordered_at').execute()
      .catch(() => []);
    const orders = await this.db.selectFrom('med_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id').leftJoin('med_frequencies as fq', 'fq.code', 'o.frequency_code')
      .select(['o.category', 'o.dose', 'o.dose_unit', 'o.route_code', 'o.order_type', 'o.rate_ml_h', 'fq.name as freq',
        sql<string>`CASE WHEN o.category = 'medication' THEN coalesce(g.inn || coalesce(' ' || g.strength, ''), o.drug_text) ELSE o.text END`.as('title')])
      .where('o.encounter_id', '=', encounterId).where('o.status', '=', 'active').where('o.category', '=', 'medication').orderBy('o.created_at').execute();
    const n1 = (x: string | number | null | undefined) => (x === null || x === undefined ? '' : String(Math.round(Number(x) * 10) / 10));
    const lines: string[] = [];
    if (v) {
      const t = new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v.recorded_at));
      lines.push(`ვიტალები (${t}): ${[v.systolic_bp && `წნევა ${v.systolic_bp}/${v.diastolic_bp ?? '–'}`, v.heart_rate && `პულსი ${v.heart_rate}`, v.respiratory_rate && `სუნთქვა ${v.respiratory_rate}`,
        v.spo2 && `SpO₂ ${v.spo2}%${v.o2_supplement ? ` (O₂${v.o2_flow ? ` ${n1(v.o2_flow)} ლ/წთ` : ''})` : ''}`, v.temperature && `ტ° ${n1(v.temperature)}`, v.consciousness && `ცნობიერება ${v.consciousness}`,
        v.pain != null && `ტკივილი ${v.pain}/10`, v.glucose && `გლუკოზა ${n1(v.glucose)}`, v.news2 != null && `NEWS2 ${v.news2}`].filter(Boolean).join(', ')}`);
    }
    if (Number(f.i) || Number(f.o)) lines.push(`სითხის ბალანსი (24 სთ): მიღება ${Math.round(Number(f.i))} მლ, გამოყოფა ${Math.round(Number(f.o))} მლ (${Number(f.i) - Number(f.o) >= 0 ? '+' : ''}${Math.round(Number(f.i) - Number(f.o))})`);
    const arrow: Record<string, string> = { L: '↓', H: '↑', LL: '↓↓', HH: '↑↑', A: '(!)' };
    for (const l of labs) {
      if (l.section !== 'lab') { lines.push(`${l.name}: ${l.impression ?? l.report_text ?? ''}`); continue; }
      const abn = l.results.filter((r) => r.flag && r.flag !== 'N');
      lines.push(`${l.name}: ${abn.length ? abn.map((r) => `${r.name} ${r.value_num !== null ? Number(r.value_num) : r.value_text}${r.unit ? ` ${r.unit}` : ''} ${arrow[r.flag!] ?? ''}`.trim()).join('; ') : 'ნორმის ფარგლებში'}`);
    }
    if (orders.length) lines.push(`მკურნალობა: ${orders.map((o) => [o.title, o.dose && `${n1(o.dose)} ${o.dose_unit ?? ''}`.trim(), o.route_code, o.order_type === 'continuous' ? `${n1(o.rate_ml_h)} მლ/სთ` : o.order_type === 'prn' ? 'PRN' : o.freq].filter(Boolean).join(' ')).join('; ')}`);
    return { text: lines.join('\n') };
  }

  /** ეპიკრიზისთვის: დაავადების მიმდინარეობა — დღიურების შეფასებები (A) თარიღებით + კონსულტაციების დასკვნები */
  async course(encounterId: string) {
    const rows = await this.base().where('n.encounter_id', '=', encounterId).where('n.status', '=', 'signed').where('n.superseded_at', 'is', null)
      .where('n.kind', 'in', ['progress', 'icu_daily', 'rounds', 'consult', 'icu_out']).orderBy('n.note_date').orderBy('n.created_at').execute();
    const dd = (d: string) => d.split('-').reverse().join('/');
    const lines = rows.map((n) => {
      const c = n.content as Record<string, string>;
      if (n.kind === 'progress') return `${dd(n.day)}: ${(c.a ?? '').trim()}`;
      if (n.kind === 'icu_daily') return `${dd(n.day)} (რეანიმაცია): ${(c.assessment ?? '').trim()}`;
      if (n.kind === 'icu_out') return `${dd(n.day)} (რეანიმაციიდან გაყვანა): ${(c.course ?? '').trim()}${c.recommendations ? ` რეკომენდაცია: ${c.recommendations.trim()}` : ''}`;
      if (n.kind === 'rounds') return `${dd(n.day)} (შემოვლა): ${(c.findings ?? '').trim()}`;
      return `${dd(n.day)} (კონსულტაცია — ${n.department_name ?? n.author_specialty ?? n.author_name}): ${(c.assessment ?? '').trim()}${c.recommendations ? ` რეკომენდაცია: ${c.recommendations.trim()}` : ''}`;
    }).filter((l) => !l.endsWith(': '));
    return { text: lines.join('\n') };
  }

  // ---------------------------------------------------------------- კონსულტაციები
  private consultBase(ex: Ex = this.db) {
    return ex.selectFrom('consultations as c').leftJoin('users as r', 'r.id', 'c.requested_by').leftJoin('users as t', 't.id', 'c.target_doctor_id')
      .leftJoin('departments as td', 'td.id', 'c.target_department_id').leftJoin('departments as fd', 'fd.id', 'c.from_department_id').leftJoin('users as a', 'a.id', 'c.answered_by')
      .selectAll('c').select([sql<string>`r.last_name || ' ' || r.first_name`.as('requested_by_name'), sql<string | null>`t.last_name || ' ' || t.first_name`.as('target_doctor_name'),
        'td.name as target_department_name', 'fd.name as from_department_name', sql<string | null>`a.last_name || ' ' || a.first_name`.as('answered_by_name')]);
  }
  async requestConsult(encounterId: string, dto: ConsultDto, u: AuthUser, ctx: AuditContext) {
    if (!dto.target_department_id && !dto.target_doctor_id) throw new BadRequestException('მიუთითეთ განყოფილება ან ექიმი');
    const s = await this.ipd.settings();
    const res = await this.db.transaction().execute(async (trx) => {
      const st = await this.stay(encounterId, trx);
      if (st.status !== 'active') throw new ConflictException('კონსულტაცია — მხოლოდ აქტიურ ჰოსპიტალიზაციაზე');
      if (!(await this.canWrite(u, st, trx))) throw new ForbiddenException('კონსულტაციას ითხოვს მკურნალი ან განყოფილების ექიმი');
      let depId = dto.target_department_id ?? null;
      if (dto.target_doctor_id) {
        const d = await trx.selectFrom('users as x').innerJoin('user_capabilities as c', 'c.user_id', 'x.id').select(['x.id', 'x.department_id']).where('x.id', '=', dto.target_doctor_id)
          .where('x.is_active', '=', true).where(sql<boolean>`c.capabilities && ARRAY['doctor']::varchar[]`).executeTakeFirst();
        if (!d) throw new BadRequestException('ექიმი ვერ მოიძებნა');
        if (d.id === u.id) throw new BadRequestException('საკუთარ თავს კონსულტაციას ვერ მოითხოვთ');
        depId = depId ?? d.department_id;
      } else if (depId) {
        const d = await trx.selectFrom('departments').select('id').where('id', '=', depId).where('is_active', '=', true).executeTakeFirst();
        if (!d) throw new BadRequestException('განყოფილება ვერ მოიძებნა');
      }
      const hours = (s.consult_due_hours ?? { routine: 24, urgent: 2, emergency: 1 })[dto.urgency] ?? 24;
      const c = await trx.insertInto('consultations').values({ encounter_id: encounterId, patient_id: st.patient_id, requested_by: u.id, from_department_id: st.department_id,
        target_department_id: depId, target_doctor_id: dto.target_doctor_id ?? null, urgency: dto.urgency, question: dto.question.trim(),
        due_at: new Date(Date.now() + hours * 3_600_000) }).returningAll().executeTakeFirstOrThrow();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'consult_requested', data: { consultation_id: c.id, urgency: dto.urgency } }, u);
      await this.audit.log(ctx, { action: 'CONSULT_REQUEST', entityName: 'consultations', entityId: c.id, newData: dto }, trx);
      return { c, st };
    });
    const to = res.c.target_doctor_id ? [res.c.target_doctor_id] : res.c.target_department_id ? await this.doctorsOf(res.c.target_department_id) : [];
    await this.notifyIds(to, { kind: 'ipd_consult', title: `კონსულტაცია (${URGENCY_KA[res.c.urgency]}): ${res.st.last_name} ${res.st.first_name}`, body: res.c.question.slice(0, 200),
      item: res.st.adm_no, entityId: res.c.id, link: `/inpatient?tab=consults`, urgent: res.c.urgency !== 'routine' }, u.id);
    return (await this.consultBase().where('c.id', '=', res.c.id).executeTakeFirst())!;
  }
  async cancelConsult(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('consultations').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('კონსულტაცია ვერ მოიძებნა');
      if (c.status !== 'requested') throw new ConflictException('კონსულტაცია უკვე დასრულებულია / გაუქმებულია');
      if (c.requested_by !== u.id && !has(u, 'admin')) throw new ForbiddenException('აუქმებს მომთხოვნი');
      await trx.updateTable('consultations').set({ status: 'cancelled', cancelled_by: u.id, cancelled_at: sql`now()`, cancel_reason: reason.trim() }).where('id', '=', id).execute();
      await this.ipd.event(trx, { encounter_id: c.encounter_id, kind: 'consult_cancelled', data: { consultation_id: id, reason } }, u);
      await this.audit.log(ctx, { action: 'CONSULT_CANCEL', entityName: 'consultations', entityId: id, newData: { reason } }, trx);
      return { id, status: 'cancelled' };
    });
  }
  /** კონსულტანტის სია: ჩემთვის / ჩემი განყოფილებისთვის (ღია + ბოლო 3 დღის პასუხები) */
  async inbox(u: AuthUser) {
    const me = await this.ipd.me(u);
    return this.consultBase().innerJoin('inpatient_stays as st', 'st.encounter_id', 'c.encounter_id').innerJoin('patients as p', 'p.id', 'c.patient_id')
      .select(['st.adm_no', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender',
        sql<string | null>`(SELECT b.code FROM bed_assignments ba JOIN beds b ON b.id = ba.bed_id WHERE ba.encounter_id = c.encounter_id AND ba.ended_at IS NULL LIMIT 1)`.as('bed_code'),
        sql<string | null>`(SELECT d.name FROM bed_assignments ba JOIN departments d ON d.id = ba.department_id WHERE ba.encounter_id = c.encounter_id AND ba.ended_at IS NULL LIMIT 1)`.as('patient_department'),
        sql<string | null>`(SELECT n.id FROM doctor_notes n WHERE n.consultation_id = c.id AND n.status = 'draft' AND n.author_id = ${u.id} LIMIT 1)`.as('my_draft_id')])
      .where((eb) => eb.or([eb('c.target_doctor_id', '=', u.id),
        ...(me.department_id ? [eb.and([eb('c.target_doctor_id', 'is', null), eb('c.target_department_id', '=', me.department_id)])] : []),
        ...(has(u, 'admin') ? [eb.val(true)] : [])]))
      .where((eb) => eb.or([eb('c.status', '=', 'requested'), eb('c.answered_at', '>', sql<Date>`now() - interval '3 days'`)]))
      .orderBy(sql`c.status = 'requested'`, 'desc').orderBy(sql`CASE c.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END`).orderBy('c.due_at').limit(200).execute();
  }

  // ---------------------------------------------------------------- შაბლონები
  templates(u: AuthUser, kind?: string) {
    return this.ipd.me(u).then((me) => {
      let q = this.db.selectFrom('note_templates as t').leftJoin('departments as d', 'd.id', 't.department_id')
        .selectAll('t').select('d.name as department_name').where('t.is_active', '=', true)
        .where((eb) => eb.or([eb('t.owner_id', '=', u.id), ...(me.department_id ? [eb('t.department_id', '=', me.department_id)] : [])]));
      if (kind) q = q.where('t.kind', '=', kind);
      return q.orderBy('t.kind').orderBy('t.department_id').orderBy('t.name').execute();
    });
  }
  async saveTemplate(id: string | null, dto: NoteTemplateDto, u: AuthUser, ctx: AuditContext) {
    const content = this.clean(dto.kind, dto.content);
    if (dto.department_id ? !(await this.isHeadDoctor(u, dto.department_id)) && !has(u, 'admin') : !has(u, 'doctor')) {
      throw new ForbiddenException(dto.department_id ? 'განყოფილების შაბლონს მართავს ხელმძღვანელი' : 'პირადი შაბლონი — ექიმი');
    }
    if (id) {
      const t = await this.db.selectFrom('note_templates').selectAll().where('id', '=', id).executeTakeFirst();
      if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
      if (t.owner_id ? t.owner_id !== u.id : !(await this.isHeadDoctor(u, t.department_id!)) && !has(u, 'admin')) throw new ForbiddenException('შაბლონს ასწორებს მფლობელი / ხელმძღვანელი');
      await this.db.updateTable('note_templates').set({ name: dto.name.trim(), content: JSON.stringify(content), is_active: dto.is_active ?? true }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'NOTE_TEMPLATE_UPDATE', entityName: 'note_templates', entityId: id, newData: dto });
      return { id };
    }
    const r = await this.db.insertInto('note_templates').values({ kind: dto.kind, name: dto.name.trim(), content: JSON.stringify(content), department_id: dto.department_id ?? null,
      owner_id: dto.department_id ? null : u.id, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'NOTE_TEMPLATE_CREATE', entityName: 'note_templates', entityId: r.id, newData: dto });
    return r;
  }

  // ---------------------------------------------------------------- PDF (სამედიცინო ისტორიისთვის)
  async pdf(encounterId: string, ctx: AuditContext) {
    const st = await this.stay(encounterId);
    const rows = await this.base().where('n.encounter_id', '=', encounterId).where('n.status', '=', 'signed').where('n.superseded_at', 'is', null)
      .orderBy('n.note_date').orderBy('n.signed_at').execute();
    const clinic = await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst();
    const FONT = join(__dirname, '..', '..', 'assets', 'fonts');
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 50, right: 50 }, bufferPages: true, info: { Title: `ექიმის ჩანაწერები — ${st.adm_no}` } });
    doc.registerFont('R', join(FONT, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
    const W = doc.page.width - 100;
    const dt = (d: string | Date) => new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
    doc.font('R').fontSize(8).fillColor('#444').text(clinic?.name ?? '', { width: W, align: 'right' }).fillColor('black');
    doc.font('B').fontSize(14).text('ექიმის ჩანაწერები', { width: W, align: 'center' });
    doc.font('R').fontSize(10).text(`${st.last_name} ${st.first_name} · ${st.adm_no} · ჰოსპიტალიზაცია: ${dt(st.admitted_at)}${st.ended_at ? ` — ${dt(st.ended_at)}` : ''}`, { width: W, align: 'center' });
    doc.moveDown(0.8);
    for (const n of rows) {
      if (doc.y > doc.page.height - 140) doc.addPage();
      const c = n.content as Record<string, string>;
      doc.font('B').fontSize(10.5).text(`${KIND_KA[n.kind as Kind]} — ${n.day.split('-').reverse().join('/')}${n.version > 1 ? ` (შესწორებული, ვ.${n.version})` : ''}`, { width: W });
      doc.font('R').fontSize(8.5).fillColor('#444').text(`${n.author_name}${n.author_specialty ? `, ${n.author_specialty}` : ''} · ხელმოწერა: ${dt(n.signed_at!)}${n.participant_names.length ? ` · მონაწილეები: ${n.participant_names.join(', ')}` : ''}`, { width: W }).fillColor('black');
      for (const f of NOTE_FIELDS[n.kind as Kind]) {
        const v = (c[f.key] ?? '').trim();
        if (!v) continue;
        doc.font('B').fontSize(9).text(f.label, { width: W });
        doc.font('R').fontSize(9.5).text(v, { width: W });
      }
      doc.moveDown(0.3).strokeColor('#ccc').moveTo(50, doc.y).lineTo(50 + W, doc.y).stroke().moveDown(0.5);
    }
    if (!rows.length) doc.font('R').fontSize(10).text('ხელმოწერილი ჩანაწერი არ არის.', { width: W });
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(i); doc.font('R').fontSize(8).fillColor('#666').text(`${st.adm_no} · გვ. ${i + 1}/${range.count}`, 50, doc.page.height - 35, { width: W, align: 'center', lineBreak: false }); }
    doc.end();
    await this.audit.log(ctx, { action: 'NOTES_PDF', entityName: 'inpatient_stays', entityId: encounterId });
    return { pdf: await done, name: `notes-${st.adm_no}.pdf` };
  }

  /** გაწერის გაფრთხილება: მიმღები გასინჯვა / დღიურის დღეები */
  async missing(encounterId: string, ex: Ex = this.db) {
    const s = await this.ipd.settings();
    const st = await this.stay(encounterId, ex);
    const rows = await ex.selectFrom('doctor_notes').select(['kind', sql<string>`to_char(note_date, 'YYYY-MM-DD')`.as('day')]).where('encounter_id', '=', encounterId)
      .where('status', '=', 'signed').where('superseded_at', 'is', null).execute();
    const days = new Set(rows.filter((r) => DAILY_KINDS.includes(r.kind)).map((r) => r.day));
    const miss: string[] = [];
    const today = await this.today(ex);
    if (s.progress_note_daily !== false) for (let d = addDay(st.admitted_day, 1); d < today; d = addDay(d, 1)) if (!days.has(d)) miss.push(d);
    return { admission: !rows.some((r) => r.kind === 'admission'), days: miss };
  }
}
export function addDay(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}

// ================================================================= controller
const READ = ['admin', 'doctor', 'nurse', 'manager'] as const;
@Controller('inpatient')
export class NotesController {
  constructor(private readonly s: NotesService) {}
  @Get('stays/:eid/notes') @Roles(...READ) list(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser) { return this.s.list(eid, u); }
  @Get('stays/:eid/notes/insert') @Roles('admin', 'doctor') insert(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.insertData(eid); }
  @Get('stays/:eid/notes/course') @Roles('admin', 'doctor') course(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.course(eid); }
  @Get('stays/:eid/notes/pdf') @Roles(...READ)
  async pdf(@Param('eid', ParseUUIDPipe) eid: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.pdf(eid, auditCtx(r));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.name}"` });
    return new StreamableFile(out.pdf);
  }
  @Post('stays/:eid/notes') @Roles('admin', 'doctor')
  create(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: NoteCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(eid, d, u, auditCtx(r)); }
  @Get('notes/:id/history') @Roles(...READ) history(@Param('id', ParseUUIDPipe) id: string) { return this.s.history(id); }
  @Get('notes/:id') @Roles(...READ)
  async one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    const n = await this.s.get(id);
    if (!n || (n.status === 'draft' && n.author_id !== u.id)) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    return n;
  }
  @Put('notes/:id') @Roles('admin', 'doctor')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteUpdateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Delete('notes/:id') @Roles('admin', 'doctor') discard(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.discard(id, u, auditCtx(r)); }
  @Post('notes/:id/sign') @HttpCode(200) @Roles('admin', 'doctor') sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.sign(id, u, auditCtx(r)); }
  @Post('notes/:id/amend') @Roles('admin', 'doctor')
  amend(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.amend(id, d.reason, u, auditCtx(r)); }

  @Post('stays/:eid/consultations') @Roles('admin', 'doctor')
  consult(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ConsultDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.requestConsult(eid, d, u, auditCtx(r)); }
  @Post('consultations/:id/cancel') @HttpCode(200) @Roles('admin', 'doctor')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelConsult(id, d.reason, u, auditCtx(r)); }
  @Get('consultations/inbox') @Roles('admin', 'doctor') inbox(@CurrentUser() u: AuthUser) { return this.s.inbox(u); }

  @Get('note-templates') @Roles('admin', 'doctor') templates(@CurrentUser() u: AuthUser, @Query('kind') kind?: string) { return this.s.templates(u, kind); }
  @Post('note-templates') @Roles('admin', 'doctor') addT(@Body() d: NoteTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveTemplate(null, d, u, auditCtx(r)); }
  @Patch('note-templates/:id') @Roles('admin', 'doctor')
  editT(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveTemplate(id, d, u, auditCtx(r)); }
}

@Module({ imports: [InpatientModule], providers: [NotesService], controllers: [NotesController], exports: [NotesService] })
export class NotesModule {}

export { MaxLength };
