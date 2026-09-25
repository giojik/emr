import { Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { withPgErrors } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { AllergyCheckService } from './allergy-check.service';

export class CreateAllergyDto {
  @IsString() @Length(2, 150) substance: string;
  @IsIn(['allergy', 'intolerance']) allergy_type: 'allergy' | 'intolerance';
  @IsIn(['mild', 'moderate', 'severe']) severity: 'mild' | 'moderate' | 'severe';   // სავალდებულო — ნაგულისხმევი აღარ არის
  @IsOptional() @IsString() @MaxLength(100) reaction_type?: string;
}
export class DeactivateAllergyDto {
  @IsBoolean() is_active: false;
  @IsString() @Length(5, 1000) reason: string;          // მაგ. "ალერგოლოგის ტესტით არ დადასტურდა"
}
export class TermDto { @IsString() @Length(3, 100) term: string }

@Injectable()
export class AllergiesService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  list(patientId: string) {
    return this.db.selectFrom('patient_allergies').selectAll().where('patient_id', '=', patientId)
      .orderBy('is_active', 'desc').orderBy('created_at', 'desc').execute();
  }

  add(patientId: string, dto: CreateAllergyDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const a = await trx.insertInto('patient_allergies').values({ patient_id: patientId, recorded_by: user.id, ...dto })
        .returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ADD_ALLERGY', entityName: 'patient_allergies', entityId: a.id, newData: a }, trx);
      return a;
    }), { patient_allergies_patient_id_fkey: 'პაციენტი ვერ მოიძებნა' });
  }

  /** ალერგია არ იშლება — მხოლოდ დეაქტივაცია დასაბუთებით (ისტორია რჩება) */
  deactivate(patientId: string, id: string, reason: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const a = await trx.updateTable('patient_allergies').set({ is_active: false, deactivated_reason: reason })
        .where('id', '=', id).where('patient_id', '=', patientId).returningAll().executeTakeFirst();
      if (!a) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: 'DEACTIVATE_ALLERGY', entityName: 'patient_allergies', entityId: id, newData: { reason } }, trx);
      return a;
    });
  }

  groups() {
    return this.db.selectFrom('allergen_groups as g').selectAll('g')
      .select((eb) => [
        jsonArrayFrom(eb.selectFrom('allergen_group_terms as t').select('t.term').whereRef('t.group_code', '=', 'g.code').orderBy('t.term')).as('terms'),
        jsonArrayFrom(eb.selectFrom('allergen_cross_reactivity as c')
          .select(sql<string>`CASE WHEN c.group_a = g.code THEN c.group_b ELSE c.group_a END`.as('code'))
          .where((w) => w.or([w('c.group_a', '=', w.ref('g.code')), w('c.group_b', '=', w.ref('g.code'))]))).as('cross_reactive'),
      ]).orderBy('g.code').execute();
  }

  /** ტერმინის ცვლილება ჯგუფს ხელახლა "დაუმტკიცებელს" ხდის */
  async addTerm(code: string, term: string, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      await trx.insertInto('allergen_group_terms').values({ group_code: code, term: term.trim().toLowerCase() }).execute();
      await trx.updateTable('allergen_groups').set({ needs_review: true, reviewed_by: null, reviewed_at: null }).where('code', '=', code).execute();
      await this.audit.log(ctx, { action: 'ADD_ALLERGEN_TERM', entityName: 'allergen_groups', entityId: code, newData: { term } }, trx);
      return { code, term };
    }), { allergen_group_terms_pkey: 'ტერმინი უკვე არსებობს', allergen_group_terms_group_code_fkey: 'ჯგუფი არ არსებობს' });
  }

  async removeTerm(code: string, term: string, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const r = await trx.deleteFrom('allergen_group_terms').where('group_code', '=', code).where('term', '=', term).executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw new NotFoundException('ტერმინი ვერ მოიძებნა');
      await trx.updateTable('allergen_groups').set({ needs_review: true, reviewed_by: null, reviewed_at: null }).where('code', '=', code).execute();
      await this.audit.log(ctx, { action: 'REMOVE_ALLERGEN_TERM', entityName: 'allergen_groups', entityId: code, oldData: { term } }, trx);
    });
  }

  async approve(code: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const g = await trx.updateTable('allergen_groups').set({ needs_review: false, reviewed_by: user.id, reviewed_at: sql`now()` })
        .where('code', '=', code).returningAll().executeTakeFirst();
      if (!g) throw new NotFoundException('ჯგუფი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: 'APPROVE_ALLERGEN_GROUP', entityName: 'allergen_groups', entityId: code }, trx);
      return g;
    });
  }
}

@Controller()
export class AllergiesController {
  constructor(private readonly allergies: AllergiesService, private readonly checker: AllergyCheckService) {}

  @Get('patients/:id/allergies') @Roles('admin', 'doctor', 'nurse', 'receptionist', 'pharmacist', 'diagnostic', 'radiographer', 'radiologist')
  list(@Param('id', ParseUUIDPipe) id: string) { return this.allergies.list(id); }

  @Post('patients/:id/allergies') @Roles('admin', 'doctor', 'nurse', 'receptionist')
  add(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAllergyDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.allergies.add(id, dto, u, auditCtx(req));
  }

  @Patch('patients/:id/allergies/:aid') @Roles('admin', 'doctor')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Param('aid', ParseUUIDPipe) aid: string, @Body() dto: DeactivateAllergyDto, @Req() req: Request) {
    return this.allergies.deactivate(id, aid, dto.reason, auditCtx(req));
  }

  /** ცოცხალი შემოწმება UI-სთვის (დანიშნულების აკრეფისას) */
  @Post('patients/:id/allergy-check') @Roles('admin', 'doctor', 'nurse', 'pharmacist')
  check(@Param('id', ParseUUIDPipe) id: string, @Body() body: { medication_name?: string }) {
    return this.checker.check(id, String(body?.medication_name ?? ''));
  }

  @Get('allergen-groups') @Roles('admin', 'doctor', 'pharmacist')
  groups() { return this.allergies.groups(); }

  @Post('allergen-groups/:code/terms') @Roles('admin', 'pharmacist')
  addTerm(@Param('code') code: string, @Body() dto: TermDto, @Req() req: Request) { return this.allergies.addTerm(code, dto.term, auditCtx(req)); }

  @Delete('allergen-groups/:code/terms/:term') @Roles('admin', 'pharmacist')
  removeTerm(@Param('code') code: string, @Param('term') term: string, @Req() req: Request) { return this.allergies.removeTerm(code, term, auditCtx(req)); }

  @Post('allergen-groups/:code/approve') @Roles('admin', 'pharmacist')
  approve(@Param('code') code: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.allergies.approve(code, u, auditCtx(req)); }
}

@Module({ controllers: [AllergiesController], providers: [AllergiesService, AllergyCheckService], exports: [AllergyCheckService] })
export class AllergiesModule {}
