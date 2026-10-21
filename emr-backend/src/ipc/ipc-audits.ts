import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post,
  Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
  ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_AGG, IPC_FULL, IpcCommon, ipcRules } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** აუდიტის სია / შევსება: IPC + განყოფილების ხელმძღვანელი (ექიმი / ექთანი; audit_by_dept_head) */
const AUDIT_ROLES: Role[] = ['infection', 'infection_dept', 'doctor', 'nurse'];
export const PROF_KA: Record<string, string> = { doctor: 'ექიმი', nurse: 'ექთანი', assistant: 'უმცროსი პერსონალი', student: 'სტუდენტი / რეზიდენტი', other: 'სხვა' };
export const ACTION_KA: Record<string, string> = { rub: 'ალკოჰოლიანი ანტისეპტიკი', wash: 'დაბანა', missed: 'გამოტოვება' };
export const MOMENT_KA: Record<number, string> = { 1: 'შეხებამდე', 2: 'ასეპტიკურ პროცედურამდე', 3: 'სითხეებთან კონტაქტის შემდეგ', 4: 'შეხების შემდეგ', 5: 'გარემოსთან შეხების შემდეგ' };

class TemplateItemDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsString() @MaxLength(100) section?: string | null;
  @IsString() @Length(3, 500) text: string;
}
class TemplateDto {
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,19}$/) code?: string;
  @IsOptional() @IsString() @Length(3, 200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(100) target?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => TemplateItemDto) items?: TemplateItemDto[];
}
class AuditDto {
  @IsUUID() template_id: string;
  @IsUUID() department_id: string;
  @IsOptional() @IsDateString() audited_at?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}
class AuditPatchDto {
  @IsOptional() @IsDateString() audited_at?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}
class AnswerDto {
  @IsUUID() item_id: string;
  @IsIn(['yes', 'no', 'na']) answer: string;
  @IsOptional() @IsString() @MaxLength(500) comment?: string | null;
}
class AnswersDto { @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AnswerDto) answers: AnswerDto[] }
class ObsDto {
  @IsIn(['doctor', 'nurse', 'assistant', 'student', 'other']) profession: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @IsInt({ each: true }) @Min(1, { each: true }) @Max(5, { each: true }) moments: number[];
  @IsIn(['rub', 'wash', 'missed']) action: string;
  @IsOptional() @IsBoolean() gloves?: boolean;
  @IsOptional() @IsString() @MaxLength(500) comment?: string | null;
}

/**
 * ჩეკლისტები / აუდიტები (0072):
 *  • შაბლონი: hand_hygiene (WHO 5 მომენტი — დაკვირვებები) / checklist (კითხვები: კი / არა / არ ეხება); რედაქტირება — infection (კითხვის ამოღება — გათიშვა).
 *  • აუდიტი: draft → completed (შესაბამისობა ფიქსირდება; შემდეგ უცვლელი) / წაშლა (draft). ჩეკლისტი სრულდება მხოლოდ ყველა აქტიურ კითხვაზე პასუხით.
 *      checklist: კი / (კი + არა) × 100; hand_hygiene: (rub + wash) / შესაძლებლობები × 100.
 *  • ვინ: infection — ყველა განყოფილება; infection_dept — თავისი; განყოფილების ხელმძღვანელი (is_section_head) — თავისი, თუ audit_by_dept_head.
 *  • სტატისტიკა: ხელის ჰიგიენა (მომენტი, პროფესია, განყოფილება, თვე; < hh_min_obs — „არასაკმარისი“), ჩეკლისტები (საშუალო %, ხშირი „არა“).
 */
@Injectable()
export class IpcAuditsService {
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  /** რომელ განყოფილებებზე შეუძლია: null — ყველა */
  private async depts(u: AuthUser): Promise<string[] | null> {
    const r = await this.c.rules();
    if (has(u, ...IPC_FULL)) return null;
    const out = new Set<string>();
    if (has(u, 'infection_dept')) (await this.c.userDepts(u.id)).forEach((d) => out.add(d));
    if (r.audit_by_dept_head && has(u, 'doctor', 'nurse')) {
      const me = await this.db.selectFrom('users').select(['department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirst();
      if (me?.is_section_head && me.department_id) out.add(me.department_id);
    }
    if (!out.size) throw new ForbiddenException({ code: 'NO_SCOPE', message: 'აუდიტზე წვდომა არ გაქვთ (ინფექციის კონტროლი ან განყოფილების ხელმძღვანელი)' });
    return [...out];
  }
  private async check(u: AuthUser, departmentId: string) {
    const d = await this.depts(u);
    if (d && !d.includes(departmentId)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
  }

  // =============================================================== შაბლონები
  async templates(all = false) {
    await this.c.rules();
    const [t, i] = await Promise.all([
      this.db.selectFrom('ipc_audit_templates').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('ipc_audit_items').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('sort_order').execute(),
    ]);
    return t.map((x) => ({ ...x, target: x.target === null ? null : Number(x.target), items: i.filter((y) => y.template_id === x.id) }));
  }

  async saveTemplate(id: string | null, d: TemplateDto, req: Request) {
    await this.c.rules();
    const ex = id ? await this.db.selectFrom('ipc_audit_templates').selectAll().where('id', '=', id).executeTakeFirst() : null;
    if (id && !ex) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
    if (!id) {
      if (!d.code || !d.name || !d.items?.length) throw new BadRequestException({ code: 'REQUIRED', message: 'კოდი, სახელი და მინიმუმ ერთი კითხვა სავალდებულოა' });
      if (await this.db.selectFrom('ipc_audit_templates').select('id').where('code', '=', d.code).executeTakeFirst())
        throw new ConflictException({ code: 'DUPLICATE', message: 'ასეთი კოდი უკვე არსებობს' });
    } else if (d.code !== undefined && d.code !== ex!.code) throw new BadRequestException({ code: 'CODE_FIXED', message: 'კოდი არ იცვლება' });
    if (ex?.kind === 'hand_hygiene' && d.items) throw new BadRequestException({ code: 'HH_FIXED', message: 'ხელის ჰიგიენის შაბლონს კითხვები არ აქვს (WHO 5 მომენტი)' });
    const tid = await this.db.transaction().execute(async (trx) => {
      let tId = id;
      const vals = Object.fromEntries(Object.entries({ name: d.name?.trim(), description: d.description === undefined ? undefined : d.description?.trim() || null,
        target: d.target, is_active: d.is_active }).filter(([, v]) => v !== undefined));
      if (!tId) tId = (await trx.insertInto('ipc_audit_templates').values({ code: d.code!, name: d.name!.trim(), kind: 'checklist', description: d.description?.trim() || null,
        target: d.target ?? null, is_active: d.is_active ?? true, sort_order: 100 }).returning('id').executeTakeFirstOrThrow()).id;
      else if (Object.keys(vals).length) await trx.updateTable('ipc_audit_templates').set(vals).where('id', '=', tId).execute();
      if (d.items) {
        const cur = await trx.selectFrom('ipc_audit_items').select('id').where('template_id', '=', tId).execute();
        const keep = new Set(d.items.filter((x) => x.id).map((x) => x.id!));
        if ([...keep].some((k) => !cur.some((c) => c.id === k))) throw new BadRequestException({ code: 'ITEM_NOT_FOUND', message: 'კითხვა ამ შაბლონს არ ეკუთვნის' });
        for (const c of cur) if (!keep.has(c.id)) await trx.updateTable('ipc_audit_items').set({ is_active: false }).where('id', '=', c.id).execute();
        for (const [i, x] of d.items.entries()) {
          const v = { section: x.section?.trim() || null, text: x.text.trim(), sort_order: (i + 1) * 10, is_active: true };
          if (x.id) await trx.updateTable('ipc_audit_items').set(v).where('id', '=', x.id).execute();
          else await trx.insertInto('ipc_audit_items').values({ template_id: tId, ...v }).execute();
        }
      }
      return tId;
    });
    await this.audit.log(auditCtx(req), { action: id ? 'IPC_AUDIT_TEMPLATE_UPDATE' : 'IPC_AUDIT_TEMPLATE_CREATE', entityName: 'ipc_audit_templates', entityId: tid,
      newData: { ...d, items: d.items?.length } });
    return (await this.templates(true)).find((x) => x.id === tid);
  }

  // =============================================================== აუდიტები
  async list(u: AuthUser, q: { template_id?: string; department_id?: string; status?: string; from?: string; to?: string }) {
    const d = await this.depts(u);
    let x = this.db.selectFrom('ipc_audits as a').innerJoin('ipc_audit_templates as t', 't.id', 'a.template_id').innerJoin('departments as d', 'd.id', 'a.department_id')
      .innerJoin('users as au', 'au.id', 'a.auditor_id')
      .select(['a.id', 'a.template_id', 't.name as template', 't.kind', 'a.department_id', 'd.name as department', 'a.audited_at', 'a.location', 'a.status', 'a.completed_at',
        'a.yes_n', 'a.no_n', 'a.na_n', 'a.opps_n', 'a.done_n', 'a.compliance', 'a.auditor_id', sql<string>`au.last_name || ' ' || au.first_name`.as('auditor'),
        sql<number>`(SELECT count(*)::int FROM ipc_hh_observations o WHERE o.audit_id = a.id)`.as('obs_n'),
        sql<number>`(SELECT count(*)::int FROM ipc_audit_answers x WHERE x.audit_id = a.id)`.as('answers_n')])
      .orderBy('a.audited_at', 'desc').limit(500);
    if (d) x = x.where('a.department_id', 'in', d);
    if (q.template_id) x = x.where('a.template_id', '=', q.template_id);
    if (q.department_id) x = x.where('a.department_id', '=', q.department_id);
    if (q.status) x = x.where('a.status', '=', q.status);
    if (q.from && DATE.test(q.from)) x = x.where(sql<boolean>`(a.audited_at AT TIME ZONE ${TZ})::date >= ${q.from}::date`);
    if (q.to && DATE.test(q.to)) x = x.where(sql<boolean>`(a.audited_at AT TIME ZONE ${TZ})::date <= ${q.to}::date`);
    return (await x.execute()).map((r) => ({ ...r, compliance: r.compliance === null ? null : Number(r.compliance) }));
  }

  private async load(id: string) {
    const a = await this.db.selectFrom('ipc_audits as a').innerJoin('ipc_audit_templates as t', 't.id', 'a.template_id').innerJoin('departments as d', 'd.id', 'a.department_id')
      .innerJoin('users as au', 'au.id', 'a.auditor_id')
      .selectAll('a').select(['t.name as template', 't.kind', 't.target', 'd.name as department', sql<string>`au.last_name || ' ' || au.first_name`.as('auditor')])
      .where('a.id', '=', id).executeTakeFirst();
    if (!a) throw new NotFoundException('აუდიტი ვერ მოიძებნა');
    return a;
  }

  async one(u: AuthUser, id: string) {
    const a = await this.load(id);
    await this.check(u, a.department_id);
    const [items, answers, obs] = await Promise.all([
      this.db.selectFrom('ipc_audit_items').selectAll().where('template_id', '=', a.template_id)
        .where((eb) => eb.or([eb('is_active', '=', true), eb('id', 'in', eb.selectFrom('ipc_audit_answers').select('item_id').where('audit_id', '=', id))])).orderBy('sort_order').execute(),
      this.db.selectFrom('ipc_audit_answers').selectAll().where('audit_id', '=', id).execute(),
      this.db.selectFrom('ipc_hh_observations').selectAll().where('audit_id', '=', id).orderBy('created_at').execute(),
    ]);
    const edit = a.status === 'draft' && (a.auditor_id === u.id || has(u, ...IPC_FULL));
    return { ...a, target: a.target === null ? null : Number(a.target), compliance: a.compliance === null ? null : Number(a.compliance), items, answers, observations: obs, can_edit: edit };
  }

  async create(u: AuthUser, d: AuditDto, req: Request) {
    await this.check(u, d.department_id);
    const t = await this.db.selectFrom('ipc_audit_templates').select(['id', 'is_active']).where('id', '=', d.template_id).executeTakeFirst();
    if (!t || !t.is_active) throw new BadRequestException({ code: 'TEMPLATE', message: 'შაბლონი ვერ მოიძებნა ან გათიშულია' });
    const dep = await this.db.selectFrom('departments').select('id').where('id', '=', d.department_id).where('is_active', '=', true).executeTakeFirst();
    if (!dep) throw new BadRequestException({ code: 'DEPARTMENT', message: 'განყოფილება ვერ მოიძებნა' });
    if (d.audited_at && new Date(d.audited_at).getTime() > Date.now() + 5 * 60_000) throw new BadRequestException({ code: 'FUTURE', message: 'აუდიტის დრო მომავალშია' });
    const r = await this.db.insertInto('ipc_audits').values({ template_id: d.template_id, department_id: d.department_id, audited_at: d.audited_at ?? sql`now()`,
      location: d.location?.trim() || null, note: d.note?.trim() || null, auditor_id: u.id }).returning('id').executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'IPC_AUDIT_CREATE', entityName: 'ipc_audits', entityId: r.id, newData: d });
    return this.one(u, r.id);
  }

  private async editable(u: AuthUser, id: string) {
    const a = await this.load(id);
    await this.check(u, a.department_id);
    if (a.status !== 'draft') throw new ConflictException({ code: 'COMPLETED', message: 'აუდიტი დასრულებულია — ცვლილება შეუძლებელია' });
    if (a.auditor_id !== u.id && !has(u, ...IPC_FULL)) throw new ForbiddenException({ code: 'NOT_AUTHOR', message: 'აუდიტს ცვლის მხოლოდ ავტორი ან ინფექციის კონტროლი' });
    return a;
  }

  async patch(u: AuthUser, id: string, d: AuditPatchDto) {
    await this.editable(u, id);
    const vals = Object.fromEntries(Object.entries({ audited_at: d.audited_at, location: d.location === undefined ? undefined : d.location?.trim() || null,
      note: d.note === undefined ? undefined : d.note?.trim() || null }).filter(([, v]) => v !== undefined));
    if (d.audited_at && new Date(d.audited_at).getTime() > Date.now() + 5 * 60_000) throw new BadRequestException({ code: 'FUTURE', message: 'აუდიტის დრო მომავალშია' });
    if (Object.keys(vals).length) await this.db.updateTable('ipc_audits').set(vals).where('id', '=', id).execute();
    return this.one(u, id);
  }

  async answers(u: AuthUser, id: string, d: AnswersDto) {
    const a = await this.editable(u, id);
    if (a.kind !== 'checklist') throw new BadRequestException({ code: 'KIND', message: 'ხელის ჰიგიენის აუდიტს — დაკვირვებები' });
    const items = await this.db.selectFrom('ipc_audit_items').select('id').where('template_id', '=', a.template_id).where('is_active', '=', true).execute();
    if (d.answers.some((x) => !items.some((i) => i.id === x.item_id))) throw new BadRequestException({ code: 'ITEM_NOT_FOUND', message: 'კითხვა ამ შაბლონს არ ეკუთვნის' });
    await this.db.transaction().execute(async (trx) => {
      for (const x of d.answers) await trx.insertInto('ipc_audit_answers').values({ audit_id: id, item_id: x.item_id, answer: x.answer, comment: x.comment?.trim() || null })
        .onConflict((oc) => oc.columns(['audit_id', 'item_id']).doUpdateSet({ answer: x.answer, comment: x.comment?.trim() || null })).execute();
    });
    return this.one(u, id);
  }

  async addObs(u: AuthUser, id: string, d: ObsDto) {
    const a = await this.editable(u, id);
    if (a.kind !== 'hand_hygiene') throw new BadRequestException({ code: 'KIND', message: 'დაკვირვება — მხოლოდ ხელის ჰიგიენის აუდიტში' });
    const moments = [...new Set(d.moments)].sort();
    await this.db.insertInto('ipc_hh_observations').values({ audit_id: id, profession: d.profession, moments, action: d.action, gloves: d.gloves ?? false,
      comment: d.comment?.trim() || null }).execute();
    return this.one(u, id);
  }

  async delObs(u: AuthUser, id: string, obsId: string) {
    await this.editable(u, id);
    const r = await this.db.deleteFrom('ipc_hh_observations').where('id', '=', obsId).where('audit_id', '=', id).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw new NotFoundException('დაკვირვება ვერ მოიძებნა');
    return this.one(u, id);
  }

  async complete(u: AuthUser, id: string, req: Request) {
    const a = await this.editable(u, id);
    let vals: Record<string, unknown>;
    if (a.kind === 'checklist') {
      const [items, ans] = await Promise.all([
        this.db.selectFrom('ipc_audit_items').select('id').where('template_id', '=', a.template_id).where('is_active', '=', true).execute(),
        this.db.selectFrom('ipc_audit_answers').select(['item_id', 'answer']).where('audit_id', '=', id).execute()]);
      const missing = items.filter((i) => !ans.some((x) => x.item_id === i.id)).length;
      if (missing) throw new BadRequestException({ code: 'INCOMPLETE', message: `პასუხი აკლია ${missing} კითხვას` });
      const y = ans.filter((x) => x.answer === 'yes').length; const n = ans.filter((x) => x.answer === 'no').length; const na = ans.filter((x) => x.answer === 'na').length;
      vals = { yes_n: y, no_n: n, na_n: na, compliance: y + n ? Math.round((y / (y + n)) * 1000) / 10 : null };
    } else {
      const o = await this.db.selectFrom('ipc_hh_observations').select('action').where('audit_id', '=', id).execute();
      if (!o.length) throw new BadRequestException({ code: 'INCOMPLETE', message: 'დაკვირვება არ არის' });
      const done = o.filter((x) => x.action !== 'missed').length;
      vals = { opps_n: o.length, done_n: done, compliance: Math.round((done / o.length) * 1000) / 10 };
    }
    await this.db.updateTable('ipc_audits').set({ ...vals, status: 'completed', completed_at: sql`now()` }).where('id', '=', id).execute();
    await this.audit.log(auditCtx(req), { action: 'IPC_AUDIT_COMPLETE', entityName: 'ipc_audits', entityId: id, newData: vals });
    return this.one(u, id);
  }

  async remove(u: AuthUser, id: string, req: Request) {
    await this.editable(u, id);
    await this.db.deleteFrom('ipc_audits').where('id', '=', id).execute();
    await this.audit.log(auditCtx(req), { action: 'IPC_AUDIT_DELETE', entityName: 'ipc_audits', entityId: id });
    return { ok: true };
  }

  // =============================================================== სტატისტიკა
  async stats(u: AuthUser, q: { from?: string; to?: string; department_id?: string }) {
    const r = await this.c.rules();
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    const sc = has(u, ...IPC_AGG) ? await this.c.aggScope(u) : { full: false as const, depts: (await this.depts(u)) ?? [] };
    if (q.department_id && !sc.full && !sc.depts.includes(q.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
    const depts = q.department_id ? [q.department_id] : sc.full ? null : sc.depts;
    const w = sql`a.status = 'completed' AND (a.audited_at AT TIME ZONE ${TZ})::date BETWEEN ${q.from}::date AND ${q.to}::date
      ${depts ? sql`AND a.department_id = ANY(${sql.val(depts)}::uuid[])` : sql``}`;
    const [obs, cl, no] = await Promise.all([
      sql<{ department_id: string; department: string; ym: string; profession: string; moments: number[]; action: string }>`
        SELECT a.department_id, d.name AS department, to_char((a.audited_at AT TIME ZONE ${TZ})::date, 'YYYY-MM') AS ym, o.profession, o.moments, o.action
          FROM ipc_audits a JOIN ipc_audit_templates t ON t.id = a.template_id AND t.kind = 'hand_hygiene' JOIN ipc_hh_observations o ON o.audit_id = a.id
          JOIN departments d ON d.id = a.department_id WHERE ${w}`.execute(this.db),
      sql<{ template_id: string; template: string; target: string | null; department_id: string; department: string; n: number; avg: string | null; yes: number; no: number }>`
        SELECT t.id AS template_id, t.name AS template, t.target::text AS target, a.department_id, d.name AS department, count(*)::int AS n, avg(a.compliance)::text AS avg,
               sum(a.yes_n)::int AS yes, sum(a.no_n)::int AS no
          FROM ipc_audits a JOIN ipc_audit_templates t ON t.id = a.template_id AND t.kind = 'checklist' JOIN departments d ON d.id = a.department_id
         WHERE ${w} GROUP BY 1, 2, 3, 4, 5 ORDER BY 2, 5`.execute(this.db),
      sql<{ template_id: string; item_id: string; text: string; no: number; answered: number }>`
        SELECT a.template_id, i.id AS item_id, i.text, count(*) FILTER (WHERE x.answer = 'no')::int AS no, count(*) FILTER (WHERE x.answer <> 'na')::int AS answered
          FROM ipc_audits a JOIN ipc_audit_answers x ON x.audit_id = a.id JOIN ipc_audit_items i ON i.id = x.item_id
         WHERE ${w} GROUP BY 1, 2, 3 HAVING count(*) FILTER (WHERE x.answer = 'no') > 0 ORDER BY 4 DESC LIMIT 50`.execute(this.db),
    ]);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const agg = (rows: typeof obs.rows) => { const done = rows.filter((x) => x.action !== 'missed').length; return { opps: rows.length, done, pct: pct(done, rows.length) }; };
    const months = [...new Set(obs.rows.map((x) => x.ym))].sort();
    const deptIds = [...new Set(obs.rows.map((x) => x.department_id))];
    const hh = {
      target: r.hh_target, min_obs: r.hh_min_obs, ...agg(obs.rows),
      rub: obs.rows.filter((x) => x.action === 'rub').length, wash: obs.rows.filter((x) => x.action === 'wash').length,
      moments: [1, 2, 3, 4, 5].map((m) => ({ moment: m, label: MOMENT_KA[m], ...agg(obs.rows.filter((x) => x.moments.includes(m))) })),
      professions: Object.keys(PROF_KA).map((p) => ({ profession: p, label: PROF_KA[p], ...agg(obs.rows.filter((x) => x.profession === p)) })).filter((x) => x.opps),
      departments: deptIds.map((id) => {
        const rs = obs.rows.filter((x) => x.department_id === id);
        const a = agg(rs);
        // WHO: საიმედო შეფასებისთვის — ≥ hh_min_obs შესაძლებლობა განყოფილებაზე თვეში
        const perMonth = [...new Set(rs.map((x) => x.ym))].map((m) => rs.filter((x) => x.ym === m).length);
        return { department_id: id, department: rs[0].department, ...a, insufficient: r.hh_min_obs > 0 && perMonth.some((n) => n < r.hh_min_obs) };
      }).sort((a, b) => a.department.localeCompare(b.department)),
      months: months.map((m) => ({ ym: m, ...agg(obs.rows.filter((x) => x.ym === m)) })),
    };
    const tpl = [...new Set(cl.rows.map((x) => x.template_id))].map((id) => {
      const rs = cl.rows.filter((x) => x.template_id === id);
      const yes = rs.reduce((a, x) => a + x.yes, 0); const nn = rs.reduce((a, x) => a + x.no, 0);
      return { template_id: id, template: rs[0].template, target: rs[0].target === null ? null : Number(rs[0].target), audits: rs.reduce((a, x) => a + x.n, 0), pct: pct(yes, yes + nn),
        departments: rs.map((x) => ({ department_id: x.department_id, department: x.department, audits: x.n, pct: pct(x.yes, x.yes + x.no) })),
        top_no: no.rows.filter((x) => x.template_id === id).slice(0, 5).map((x) => ({ item_id: x.item_id, text: x.text, no: x.no, answered: x.answered, pct_no: pct(x.no, x.answered) })) };
    });
    return { from: q.from, to: q.to, hand_hygiene: hh, checklists: tpl };
  }
}

@Controller('ipc')
export class IpcAuditsController {
  constructor(private readonly s: IpcAuditsService) {}
  @Get('audit-templates') @Roles(...AUDIT_ROLES, 'infection_view') templates(@Query('all') all?: string) { return this.s.templates(all === '1'); }
  @Post('audit-templates') @Roles(...IPC_FULL) createTpl(@Body() d: TemplateDto, @Req() r: Request) { return this.s.saveTemplate(null, d, r); }
  @Patch('audit-templates/:id') @Roles(...IPC_FULL) updateTpl(@Param('id', ParseUUIDPipe) id: string, @Body() d: TemplateDto, @Req() r: Request) { return this.s.saveTemplate(id, d, r); }
  @Get('audits') @Roles(...AUDIT_ROLES) list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string | undefined>) { return this.s.list(u, q); }
  @Get('audits/stats') @Roles(...AUDIT_ROLES, 'infection_view') stats(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('department_id') department_id?: string) {
    return this.s.stats(u, { from, to, department_id });
  }
  @Get('audits/:id') @Roles(...AUDIT_ROLES) one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.s.one(u, id); }
  @Post('audits') @Roles(...AUDIT_ROLES) create(@CurrentUser() u: AuthUser, @Body() d: AuditDto, @Req() r: Request) { return this.s.create(u, d, r); }
  @Patch('audits/:id') @Roles(...AUDIT_ROLES) patch(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: AuditPatchDto) { return this.s.patch(u, id, d); }
  @Put('audits/:id/answers') @Roles(...AUDIT_ROLES) answers(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: AnswersDto) { return this.s.answers(u, id, d); }
  @Post('audits/:id/observations') @Roles(...AUDIT_ROLES) addObs(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ObsDto) { return this.s.addObs(u, id, d); }
  @Delete('audits/:id/observations/:obs') @Roles(...AUDIT_ROLES)
  delObs(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('obs', ParseUUIDPipe) obs: string) { return this.s.delObs(u, id, obs); }
  @Post('audits/:id/complete') @HttpCode(200) @Roles(...AUDIT_ROLES) complete(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.s.complete(u, id, r); }
  @Delete('audits/:id') @Roles(...AUDIT_ROLES) remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.s.remove(u, id, r); }
}
