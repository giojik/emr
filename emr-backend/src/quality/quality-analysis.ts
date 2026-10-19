import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, Res,
  StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { HARM_KA, harmRank, LEVEL_KA, QM_DEPT, QM_FULL, QmCommon, type Harm, type Trx, userName } from './quality-common';
import { QmIncidentsService } from './quality-incidents';
import { renderRcaReport } from './quality-report.pdf';

class TimelineIn { @IsOptional() @IsISO8601() at?: string | null; @IsString() @Length(2, 2000) text: string }
class FactorIn { @IsUUID() factor_id: string; @IsOptional() @IsString() @MaxLength(2000) comment?: string | null }
class TeamIn { @IsUUID() user_id: string; @IsOptional() @IsString() @MaxLength(200) role_text?: string | null }
export class AnalysisDto {
  @IsOptional() @IsString() @MaxLength(8000) what_happened?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) root_cause?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) action_taken?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(1000, { each: true }) whys?: string[];
  @IsOptional() @IsString() @MaxLength(8000) root_causes?: string | null;
  @IsOptional() @IsString() @MaxLength(8000) conclusion?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => TimelineIn) timeline?: TimelineIn[];
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => FactorIn) factors?: FactorIn[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => TeamIn) team?: TeamIn[];
}
class InvestigatorDto { @IsOptional() @IsUUID() user_id?: string | null }
class LevelDto { @IsIn(['review', 'rca']) level: 'review' | 'rca'; @IsOptional() @IsString() @MaxLength(500) reason?: string }
class ReasonDto { @IsString() @Length(3, 1000) reason: string }
class DisclosureDto {
  @IsIn(['done', 'not_disclosed']) status: 'done' | 'not_disclosed';
  @IsOptional() @IsISO8601() at?: string;
  @IsOptional() @IsIn(['in_person', 'phone', 'letter', 'other']) method?: string;
  @IsOptional() @IsUUID() by_user_id?: string;
  @IsOptional() @IsString() @MaxLength(300) to?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}
class CloseDto { @IsString() @Length(10, 8000) summary: string; @IsOptional() @IsString() @MaxLength(2000) feedback_text?: string | null }

const len = (s: string | null | undefined) => (s ?? '').trim().length;

/**
 * 0065: გამოძიება → ანალიზი (მიმოხილვა / RCA) → დამტკიცება → CAPA → ინფორმირება → დახურვა.
 * რედაქტორი: ხარისხის მენეჯერი, გამომძიებელი, RCA გუნდი (გუნდს და გაგზავნას — მხოლოდ ხარისხის მენეჯერი / გამომძიებელი).
 */
@Injectable()
export class QmAnalysisService {
  constructor(private readonly c: QmCommon, private readonly inc: QmIncidentsService, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  private async lock(trx: Trx, id: string) {
    const i = await trx.selectFrom('qm_incidents').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!i) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    return i;
  }
  private full(u: AuthUser) { if (!has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ ხარისხის მენეჯერი'); }
  private async isTeam(trx: Trx, id: string, u: AuthUser) {
    return !!(await trx.selectFrom('qm_analysis_team').select('user_id').where('incident_id', '=', id).where('user_id', '=', u.id).executeTakeFirst());
  }
  private event(trx: Trx, id: string, u: AuthUser, kind: string, text?: string | null, data?: unknown, internal = false) {
    return trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind, text: text ?? null, data: data === undefined ? null : JSON.stringify(data), internal }).execute();
  }

  // ---------------------------------------------------------------- გამომძიებელი / დონე
  async investigator(id: string, d: InvestigatorDto, u: AuthUser, req: Request) {
    await this.c.rules(); this.full(u);
    const no = await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      if (!['investigation', 'analysis', 'capa'].includes(i.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'გამომძიებელი ინიშნება მიღებულ, დაუხურავ ინციდენტზე' });
      if (d.user_id) await this.inc.activeUser(d.user_id, trx);
      await trx.updateTable('qm_incidents').set({ investigator_id: d.user_id ?? null, investigator_at: d.user_id ? sql`now()` : null }).where('id', '=', id).execute();
      await this.event(trx, id, u, 'investigator', null, { user_id: d.user_id ?? null, from: i.investigator_id });
      await this.audit.log(auditCtx(req), { action: 'QM_INVESTIGATOR', entityName: 'qm_incidents', entityId: id, oldData: { investigator_id: i.investigator_id }, newData: { investigator_id: d.user_id ?? null } }, trx);
      return i.inc_no;
    });
    if (d.user_id) await this.inc.notifyInvestigator(d.user_id, id, no);
    return this.inc.get(id, u, req, false);
  }

  async level(id: string, d: LevelDto, u: AuthUser, req: Request) {
    const r = await this.c.rules(); this.full(u);
    await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      if (i.status !== 'investigation') throw new ConflictException({ code: 'NOT_EDITABLE', message: 'დონე იცვლება ანალიზის გაგზავნამდე' });
      if (i.analysis_level === d.level) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
      if (d.level === 'review' && len(d.reason) < 3) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'დონის დაწევა (RCA → მიმოხილვა) — მიზეზით' });
      if (d.level === 'review' && i.is_sentinel) throw new BadRequestException({ code: 'SENTINEL_RCA', message: 'სენტინელურ მოვლენაზე RCA სავალდებულოა' });
      const days = d.level === 'rca' ? r.rca_days : r.review_days;
      await trx.updateTable('qm_incidents').set({ analysis_level: d.level, analysis_due_at: sql`coalesce(triaged_at, now()) + make_interval(days => ${days})`, analysis_warn_sent_at: null, analysis_overdue_sent_at: null })
        .where('id', '=', id).execute();
      await trx.insertInto('qm_analyses').values({ incident_id: id, level: d.level }).onConflict((oc) => oc.column('incident_id').doUpdateSet({ level: d.level })).execute();
      await this.event(trx, id, u, 'level', d.reason?.trim() || null, { from: i.analysis_level, to: d.level }, true);
      await this.audit.log(auditCtx(req), { action: 'QM_LEVEL', entityName: 'qm_incidents', entityId: id, oldData: { level: i.analysis_level }, newData: { level: d.level, reason: d.reason ?? null } }, trx);
    });
    return this.inc.get(id, u, req, false);
  }

  // ---------------------------------------------------------------- ანალიზი
  async save(id: string, d: AnalysisDto, u: AuthUser, req: Request) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      const q = has(u, ...QM_FULL); const isInv = i.investigator_id === u.id; const team = await this.isTeam(trx, id, u);
      if (!q && !isInv && !team) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
      if (i.status !== 'investigation') throw new ConflictException({ code: 'NOT_EDITABLE', message: 'ანალიზი გაგზავნილია — ცვლილება შეუძლებელია (დაბრუნების შემდეგ)' });
      if (d.team !== undefined && !q && !isInv) throw new ForbiddenException('RCA გუნდს ადგენს ხარისხის მენეჯერი ან გამომძიებელი');
      await trx.insertInto('qm_analyses').values({ incident_id: id, level: i.analysis_level ?? 'review' }).onConflict((oc) => oc.column('incident_id').doNothing()).execute();
      const t = (x: string | null | undefined) => (x === undefined ? undefined : x?.trim() || null);
      const vals = { what_happened: t(d.what_happened), root_cause: t(d.root_cause), action_taken: t(d.action_taken), root_causes: t(d.root_causes), conclusion: t(d.conclusion),
        ...(d.whys !== undefined && { whys: JSON.stringify(d.whys.map((w) => w.trim()).filter(Boolean)) }) };
      await trx.updateTable('qm_analyses').set({ ...Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== undefined)), updated_by: u.id,
        status: sql`CASE WHEN status = 'returned' THEN 'returned' ELSE 'draft' END` }).where('incident_id', '=', id).execute();
      if (d.timeline !== undefined) {
        await trx.deleteFrom('qm_analysis_timeline').where('incident_id', '=', id).execute();
        if (d.timeline.length) await trx.insertInto('qm_analysis_timeline').values(d.timeline.map((x, k) => ({ incident_id: id, at: x.at ?? null, text: x.text.trim(), sort_order: k }))).execute();
      }
      if (d.factors !== undefined) {
        const ids = [...new Set(d.factors.map((f) => f.factor_id))];
        if (ids.length) {
          const n = (await trx.selectFrom('qm_classifiers').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).where('kind', '=', 'factor').executeTakeFirstOrThrow()).n;
          if (n !== ids.length) throw new BadRequestException({ code: 'FACTOR', message: 'ხელშემწყობი ფაქტორი ვერ მოიძებნა' });
        }
        await trx.deleteFrom('qm_analysis_factors').where('incident_id', '=', id).execute();
        if (ids.length) await trx.insertInto('qm_analysis_factors').values(ids.map((fid) => ({ incident_id: id, factor_id: fid, comment: d.factors!.find((f) => f.factor_id === fid)?.comment?.trim() || null }))).execute();
      }
      let added: string[] = [];
      if (d.team !== undefined) {
        const ids = [...new Set(d.team.map((m) => m.user_id))];
        for (const uid of ids) await this.inc.activeUser(uid, trx);
        const before = (await trx.selectFrom('qm_analysis_team').select('user_id').where('incident_id', '=', id).execute()).map((x) => x.user_id);
        await trx.deleteFrom('qm_analysis_team').where('incident_id', '=', id).where('user_id', 'not in', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).execute();
        for (const m of d.team) {
          await trx.insertInto('qm_analysis_team').values({ incident_id: id, user_id: m.user_id, role_text: m.role_text?.trim() || null })
            .onConflict((oc) => oc.columns(['incident_id', 'user_id']).doUpdateSet({ role_text: m.role_text?.trim() || null })).execute();
        }
        added = ids.filter((x) => !before.includes(x));
      }
      await this.audit.log(auditCtx(req), { action: 'QM_ANALYSIS_SAVE', entityName: 'qm_incidents', entityId: id,
        newData: { fields: Object.keys(vals).filter((k) => (vals as Record<string, unknown>)[k] !== undefined), timeline: d.timeline?.length, factors: d.factors?.length, team: d.team?.length } }, trx);
      if (added.length) {
        await this.event(trx, id, u, 'team', null, { added });
        // გუნდის წევრებს — შეტყობინება ტრანზაქციის შემდეგ
        setImmediate(() => void this.c.bell(added, { kind: 'qm_team', title: `RCA გუნდი: ${i.inc_no}`, body: 'თქვენ დაგამატეს ინციდენტის ანალიზის გუნდში', link: `/quality/incidents/${id}`, entityId: id }));
      }
    });
    return this.inc.get(id, u, req, false);
  }

  /** გაგზავნა: სავალდებულო ველები დონის მიხედვით; ხარისხის მენეჯერი / analysis_approval = false → პირდაპირ დამტკიცებული */
  async submit(id: string, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    const out = await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      const q = has(u, ...QM_FULL);
      if (!q && i.investigator_id !== u.id) throw new ForbiddenException('ანალიზს აგზავნის გამომძიებელი ან ხარისხის მენეჯერი');
      if (i.status !== 'investigation') throw new ConflictException({ code: 'NOT_EDITABLE', message: 'ანალიზი უკვე გაგზავნილია' });
      const a = await trx.selectFrom('qm_analyses').selectAll().where('incident_id', '=', id).executeTakeFirst();
      if (!a) throw new BadRequestException({ code: 'ANALYSIS_EMPTY', message: 'ანალიზი შევსებული არ არის' });
      const level = i.analysis_level ?? a.level;
      const miss: string[] = [];
      if (level === 'review') {
        if (len(a.what_happened) < 10) miss.push('რა მოხდა');
        if (len(a.root_cause) < 5) miss.push('ძირეული მიზეზი');
        if (len(a.action_taken) < 3) miss.push('მიღებული ზომა');
      } else {
        const tl = (await trx.selectFrom('qm_analysis_timeline').select(sql<number>`count(*)::int`.as('n')).where('incident_id', '=', id).executeTakeFirstOrThrow()).n;
        const fc = (await trx.selectFrom('qm_analysis_factors').select(sql<number>`count(*)::int`.as('n')).where('incident_id', '=', id).executeTakeFirstOrThrow()).n;
        if (!tl) miss.push('ქრონოლოგია');
        if (!fc) miss.push('ხელშემწყობი ფაქტორები');
        if (!(a.whys as unknown as string[]).length) miss.push('„5 რატომ“');
        if (len(a.root_causes) < 10) miss.push('ძირეული მიზეზები');
        if (len(a.conclusion) < 10) miss.push('დასკვნა');
      }
      if (miss.length) throw new BadRequestException({ code: 'ANALYSIS_INCOMPLETE', message: `შეავსეთ: ${miss.join(', ')}`, missing: miss });
      const direct = q || !r.analysis_approval;
      await trx.updateTable('qm_analyses').set({ level, status: direct ? 'approved' : 'submitted', submitted_at: sql`now()`, submitted_by: u.id, return_reason: null,
        ...(direct && { approved_at: sql`now()`, approved_by: u.id }) }).where('incident_id', '=', id).execute();
      await trx.updateTable('qm_incidents').set({ status: direct ? 'capa' : 'analysis' }).where('id', '=', id).execute();
      await this.event(trx, id, u, direct ? 'analysis_approved' : 'analysis_submitted', null, { level });
      await this.audit.log(auditCtx(req), { action: direct ? 'QM_ANALYSIS_APPROVE' : 'QM_ANALYSIS_SUBMIT', entityName: 'qm_incidents', entityId: id, newData: { level, direct } }, trx);
      return { direct, no: i.inc_no };
    });
    if (!out.direct) {
      const q = (await this.c.usersWith(QM_FULL)).map((x) => x.id).filter((x) => x !== u.id);
      await this.c.bell(q, { kind: 'qm_analysis', title: `ანალიზი დასამტკიცებლად: ${out.no}`, link: `/quality/incidents/${id}`, entityId: id });
    }
    return this.inc.get(id, u, req, false);
  }

  async approve(id: string, u: AuthUser, req: Request) {
    await this.c.rules(); this.full(u);
    const inv = await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      if (i.status !== 'analysis') throw new ConflictException({ code: 'NOT_SUBMITTED', message: 'დასამტკიცებელი ანალიზი არ არის' });
      await trx.updateTable('qm_analyses').set({ status: 'approved', approved_at: sql`now()`, approved_by: u.id }).where('incident_id', '=', id).execute();
      await trx.updateTable('qm_incidents').set({ status: 'capa' }).where('id', '=', id).execute();
      await this.event(trx, id, u, 'analysis_approved');
      await this.audit.log(auditCtx(req), { action: 'QM_ANALYSIS_APPROVE', entityName: 'qm_incidents', entityId: id }, trx);
      return { id: i.investigator_id, no: i.inc_no };
    });
    if (inv.id) await this.c.bell([inv.id], { kind: 'qm_analysis', title: `ანალიზი დამტკიცდა: ${inv.no}`, link: `/quality/incidents/${id}`, entityId: id });
    return this.inc.get(id, u, req, false);
  }

  async returnBack(id: string, d: ReasonDto, u: AuthUser, req: Request) {
    await this.c.rules(); this.full(u);
    const inv = await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      if (i.status !== 'analysis') throw new ConflictException({ code: 'NOT_SUBMITTED', message: 'დასაბრუნებელი ანალიზი არ არის' });
      await trx.updateTable('qm_analyses').set({ status: 'returned', return_reason: d.reason.trim() }).where('incident_id', '=', id).execute();
      await trx.updateTable('qm_incidents').set({ status: 'investigation' }).where('id', '=', id).execute();
      await this.event(trx, id, u, 'analysis_returned', d.reason.trim());
      await this.audit.log(auditCtx(req), { action: 'QM_ANALYSIS_RETURN', entityName: 'qm_incidents', entityId: id, newData: { reason: d.reason } }, trx);
      return { id: i.investigator_id, no: i.inc_no };
    });
    if (inv.id) await this.c.bell([inv.id], { kind: 'qm_returned', title: `ანალიზი დაბრუნდა შესასწორებლად: ${inv.no}`, body: d.reason.trim(), link: `/quality/incidents/${id}`, entityId: id, urgent: true });
    return this.inc.get(id, u, req, false);
  }

  // ---------------------------------------------------------------- ინფორმირება / დახურვა
  async disclosure(id: string, d: DisclosureDto, u: AuthUser, req: Request) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      if (!has(u, ...QM_FULL) && i.investigator_id !== u.id) throw new ForbiddenException('ინფორმირებას აღრიცხავს ხარისხის მენეჯერი ან გამომძიებელი');
      if (!['investigation', 'analysis', 'capa'].includes(i.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'ინციდენტი დახურული / მიუღებელია' });
      if (d.status === 'done') {
        if (!d.at || !d.method) throw new BadRequestException({ code: 'DISCLOSURE_FIELDS', message: 'მიუთითეთ როდის და როგორ ეცნობა' });
        if (new Date(d.at).getTime() > Date.now() + 10 * 60_000) throw new BadRequestException({ code: 'DISCLOSURE_FIELDS', message: 'ინფორმირების დრო მომავალში ვერ იქნება' });
        if (d.by_user_id) await this.inc.activeUser(d.by_user_id, trx);
      } else if (len(d.note) < 3) throw new BadRequestException({ code: 'DISCLOSURE_FIELDS', message: '„არ ეცნობა“ — მიზეზი სავალდებულოა' });
      const v = d.status === 'done'
        ? { disclosure_status: 'done', disclosed_at: d.at!, disclosure_method: d.method!, disclosure_by: d.by_user_id ?? u.id, disclosure_to: d.to?.trim() || null, disclosure_note: d.note?.trim() || null }
        : { disclosure_status: 'not_disclosed', disclosed_at: null, disclosure_method: null, disclosure_by: null, disclosure_to: null, disclosure_note: d.note!.trim() };
      await trx.updateTable('qm_incidents').set({ ...v, disclosure_recorded_by: u.id, disclosure_recorded_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, id, u, 'disclosure', null, { status: d.status, method: d.method ?? null });
      await this.audit.log(auditCtx(req), { action: 'QM_DISCLOSURE', entityName: 'qm_incidents', entityId: id, oldData: { status: i.disclosure_status }, newData: v }, trx);
    });
    return this.inc.get(id, u, req, false);
  }

  /** დახურვის პირობები: ანალიზი დამტკიცებულია (status = capa), CAPA-ები შესრულებული / გაუქმებული, ინფორმირება (საჭიროებისას) */
  async closeCheck(id: string, trx: Trx | QmCommon['db'] = this.db) {
    const r = await this.c.rules();
    const i = await trx.selectFrom('qm_incidents').select(['status', 'affected', 'harm', 'harm_reported', 'disclosure_status']).where('id', '=', id).executeTakeFirst();
    if (!i) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    const open = await trx.selectFrom('qm_capa_incidents as ci').innerJoin('qm_capas as c', 'c.id', 'ci.capa_id').select(['c.capa_no'])
      .where('ci.incident_id', '=', id).where('c.status', 'in', ['open', 'in_progress']).execute();
    const needDisclosure = i.affected === 'patient' && r.disclosure_required_harm !== 'off' && harmRank(i.harm ?? i.harm_reported) >= harmRank(r.disclosure_required_harm);
    const blockers: { code: string; message: string }[] = [];
    if (i.status !== 'capa') blockers.push({ code: 'ANALYSIS_NOT_APPROVED', message: 'ანალიზი დამტკიცებული არ არის' });
    if (open.length) blockers.push({ code: 'CAPA_OPEN', message: `დაუსრულებელი ქმედებები: ${open.map((x) => x.capa_no).join(', ')}` });
    if (needDisclosure && !i.disclosure_status) blockers.push({ code: 'DISCLOSURE_REQUIRED', message: `პაციენტის / ოჯახის ინფორმირება აღრიცხული არ არის (ზიანი: ${HARM_KA[(i.harm ?? i.harm_reported) as Harm]})` });
    return { ok: !blockers.length, blockers, need_disclosure: needDisclosure };
  }

  async close(id: string, d: CloseDto, u: AuthUser, req: Request) {
    const r = await this.c.rules(); this.full(u);
    const out = await this.db.transaction().execute(async (trx) => {
      const i = await this.lock(trx, id);
      const chk = await this.closeCheck(id, trx);
      if (!chk.ok) throw new ConflictException({ code: chk.blockers[0].code, message: chk.blockers.map((b) => b.message).join('; '), blockers: chk.blockers });
      const fb = r.closure_feedback ? d.feedback_text?.trim() || null : null;
      await trx.updateTable('qm_incidents').set({ status: 'closed', closed_at: sql`now()`, closed_by: u.id, closure_summary: d.summary.trim(), feedback_text: fb }).where('id', '=', id).execute();
      await this.event(trx, id, u, 'closed', null, { feedback: !!fb });
      await this.audit.log(auditCtx(req), { action: 'QM_CLOSE', entityName: 'qm_incidents', entityId: id, newData: { summary: d.summary, feedback: fb } }, trx);
      return { i, fb };
    });
    const { i, fb } = out;
    if (r.author_feedback && i.reporter_id) {
      await this.c.bell([i.reporter_id], { kind: 'qm_status', title: `თქვენი შეტყობინება ${i.inc_no}`, entityId: id, link: `/quality/incidents/${id}`,
        body: `განხილვა დასრულდა.${fb ? ` ${fb}` : ''} გმადლობთ შეტყობინებისთვის.` });
    }
    const dept: string[] = [];
    for (const x of await this.c.usersWith(QM_DEPT)) if ((await this.c.userDepts(x.id)).includes(i.department_id)) dept.push(x.id);
    if (i.investigator_id) dept.push(i.investigator_id);
    await this.c.bell(dept.filter((x) => x !== u.id), { kind: 'qm_closed', title: `ინციდენტი დაიხურა: ${i.inc_no}`, link: `/quality/incidents/${id}`, entityId: id });
    return this.inc.get(id, u, req, false);
  }

  // ---------------------------------------------------------------- ჩემი ქმედებები / ანგარიში
  async myWork(u: AuthUser) {
    await this.c.rules();
    const inc = await this.db.selectFrom('qm_incidents as i').innerJoin('qm_classifiers as c', 'c.id', 'i.category_id').innerJoin('departments as d', 'd.id', 'i.department_id')
      .leftJoin('qm_analyses as a', 'a.incident_id', 'i.id')
      .select(['i.id', 'i.inc_no', 'i.status', 'i.analysis_level', 'i.analysis_due_at', 'c.name as category_name', 'd.name as department_name', 'a.status as analysis_status',
        sql<boolean>`i.investigator_id = ${u.id}`.as('is_investigator'),
        sql<boolean>`i.status IN ('investigation', 'analysis') AND i.analysis_due_at < now()`.as('overdue')])
      .where('i.status', 'in', ['investigation', 'analysis', 'capa'])
      .where((eb) => eb.or([eb('i.investigator_id', '=', u.id), eb(sql<boolean>`EXISTS (SELECT 1 FROM qm_analysis_team t WHERE t.incident_id = i.id AND t.user_id = ${u.id})`, '=', true)]))
      .orderBy('i.analysis_due_at').execute();
    const capas = await this.db.selectFrom('qm_capas as c').leftJoin('departments as d', 'd.id', 'c.department_id')
      .select(['c.id', 'c.capa_no', 'c.title', 'c.kind', 'c.status', 'c.due_date', 'd.name as department_name',
        sql<boolean>`c.status IN ('open', 'in_progress') AND c.due_date < (now() AT TIME ZONE current_setting('TimeZone'))::date`.as('overdue'),
        sql<boolean>`EXISTS (SELECT 1 FROM qm_capa_due_requests r WHERE r.capa_id = c.id AND r.status = 'pending')`.as('due_request_pending')])
      .where('c.owner_id', '=', u.id).where('c.status', 'in', ['open', 'in_progress']).orderBy('c.due_date').execute();
    return { incidents: inc.map((x) => ({ ...x, level_label: x.analysis_level ? LEVEL_KA[x.analysis_level] : null })), capas };
  }

  async report(id: string, maskQ: string | undefined, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    const d = await this.inc.get(id, u, req, false) as Awaited<ReturnType<QmIncidentsService['get']>> & Record<string, unknown>;
    if (d.access === 'own' || d.access === 'dept') throw new ForbiddenException('ანგარიში — ხარისხის მენეჯერი / გამომძიებელი');
    const mask = maskQ === undefined ? r.report_mask_patient : maskQ !== '0';
    const clinic = await this.db.selectFrom('clinic_settings').selectAll().executeTakeFirst() as { name?: string } | undefined;
    const buf = await renderRcaReport(d as never, { mask, clinic: clinic?.name ?? '' });
    await this.audit.log(auditCtx(req), { action: 'QM_REPORT_PDF', entityName: 'qm_incidents', entityId: id, newData: { mask } });
    return buf;
  }
}

@Controller('quality')
export class QmAnalysisController {
  constructor(private readonly s: QmAnalysisService) {}
  @Get('my-work') myWork(@CurrentUser() u: AuthUser) { return this.s.myWork(u); }
  @Post('incidents/:id/investigator') @HttpCode(200) @Roles(...QM_FULL)
  investigator(@Param('id', ParseUUIDPipe) id: string, @Body() d: InvestigatorDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.investigator(id, d, u, req); }
  @Post('incidents/:id/level') @HttpCode(200) @Roles(...QM_FULL)
  level(@Param('id', ParseUUIDPipe) id: string, @Body() d: LevelDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.level(id, d, u, req); }
  @Put('incidents/:id/analysis') save(@Param('id', ParseUUIDPipe) id: string, @Body() d: AnalysisDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.save(id, d, u, req); }
  @Post('incidents/:id/analysis/submit') @HttpCode(200) submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.submit(id, u, req); }
  @Post('incidents/:id/analysis/approve') @HttpCode(200) @Roles(...QM_FULL) approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.approve(id, u, req); }
  @Post('incidents/:id/analysis/return') @HttpCode(200) @Roles(...QM_FULL)
  returnBack(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.returnBack(id, d, u, req); }
  @Put('incidents/:id/disclosure') disclosure(@Param('id', ParseUUIDPipe) id: string, @Body() d: DisclosureDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.disclosure(id, d, u, req); }
  @Get('incidents/:id/close-check') @Roles(...QM_FULL) closeCheck(@Param('id', ParseUUIDPipe) id: string) { return this.s.closeCheck(id); }
  @Post('incidents/:id/close') @HttpCode(200) @Roles(...QM_FULL)
  close(@Param('id', ParseUUIDPipe) id: string, @Body() d: CloseDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.close(id, d, u, req); }
  @Get('incidents/:id/report')
  async report(@Param('id', ParseUUIDPipe) id: string, @Query('mask') mask: string | undefined, @CurrentUser() u: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const buf = await this.s.report(id, mask, u, req);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(buf);
  }
}
