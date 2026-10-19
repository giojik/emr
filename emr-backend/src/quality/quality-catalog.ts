import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/decorators';
import { QM_FULL, QmCommon } from './quality-common';

class ClassifierDto {
  @IsIn(['category', 'factor']) kind: 'category' | 'factor';
  @IsOptional() @IsUUID() parent_id?: string | null;
  @Matches(/^[a-z][a-z0-9_]{1,39}$/, { message: 'კოდი: ლათინური პატარა ასოები / ციფრები / _, 2–40' }) code: string;
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsBoolean() is_medication?: boolean;
  @IsOptional() @IsBoolean() is_sentinel?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sort_order?: number;
}
class ClassifierPatchDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsBoolean() is_medication?: boolean;
  @IsOptional() @IsBoolean() is_sentinel?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sort_order?: number;
}

/** ცნობარები (0064): კატეგორია → ქვეკატეგორია (სენტინელური ნიშნით), ხელშემწყობი ფაქტორები; კითხვა — ყველას (ფორმა), ცვლილება — quality */
@Injectable()
export class QmCatalogService {
  constructor(private readonly c: QmCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async list(kind?: string, all?: boolean) {
    await this.c.rules();
    let q = this.db.selectFrom('qm_classifiers as c').selectAll('c')
      .select(sql<number>`(SELECT count(*)::int FROM qm_incidents i WHERE i.category_id = c.id)`.as('used'))
      .orderBy(sql`c.parent_id IS NOT NULL`).orderBy('c.sort_order').orderBy('c.name');
    if (kind) q = q.where('c.kind', '=', kind);
    if (!all) q = q.where('c.is_active', '=', true);
    return q.execute();
  }

  async create(d: ClassifierDto, req: Request) {
    await this.c.rules();
    if (d.parent_id) {
      const p = await this.db.selectFrom('qm_classifiers').select(['kind', 'parent_id']).where('id', '=', d.parent_id).executeTakeFirst();
      if (!p || p.kind !== d.kind || p.parent_id) throw new BadRequestException({ code: 'PARENT', message: 'მშობელი იმავე სახის ძირეული ელემენტი უნდა იყოს (2 დონე)' });
    }
    if (d.is_sentinel && (!d.parent_id || d.kind !== 'category')) throw new BadRequestException({ code: 'SENTINEL', message: 'სენტინელური — მხოლოდ კატეგორიის ქვეელემენტი' });
    if (d.is_medication && (d.parent_id || d.kind !== 'category')) throw new BadRequestException({ code: 'MEDICATION', message: 'მედიკამენტური ნიშანი — მხოლოდ ძირეულ კატეგორიაზე' });
    const dup = await this.db.selectFrom('qm_classifiers').select('id').where('kind', '=', d.kind).where('code', '=', d.code).executeTakeFirst();
    if (dup) throw new ConflictException({ code: 'CODE_EXISTS', message: 'ასეთი კოდი უკვე არსებობს' });
    const max = await this.db.selectFrom('qm_classifiers').select(sql<number>`coalesce(max(sort_order), 0)`.as('m')).where('kind', '=', d.kind)
      .where(d.parent_id ? sql<boolean>`parent_id = ${d.parent_id}` : sql<boolean>`parent_id IS NULL`).executeTakeFirstOrThrow();
    const row = await this.db.insertInto('qm_classifiers').values({ kind: d.kind, parent_id: d.parent_id ?? null, code: d.code, name: d.name.trim(), description: d.description?.trim() || null,
      is_medication: !!d.is_medication, is_sentinel: !!d.is_sentinel, sort_order: d.sort_order ?? Number(max.m) + 10 }).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'QM_CLASSIFIER_CREATE', entityName: 'qm_classifiers', entityId: row.id, newData: d });
    return row;
  }

  async update(id: string, d: ClassifierPatchDto, req: Request) {
    await this.c.rules();
    const old = await this.db.selectFrom('qm_classifiers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!old) throw new NotFoundException('ელემენტი ვერ მოიძებნა');
    if (d.is_sentinel && (!old.parent_id || old.kind !== 'category')) throw new BadRequestException({ code: 'SENTINEL', message: 'სენტინელური — მხოლოდ კატეგორიის ქვეელემენტი' });
    if (d.is_medication && (old.parent_id || old.kind !== 'category')) throw new BadRequestException({ code: 'MEDICATION', message: 'მედიკამენტური ნიშანი — მხოლოდ ძირეულ კატეგორიაზე' });
    const row = await this.db.updateTable('qm_classifiers').set({ ...(d.name !== undefined && { name: d.name.trim() }), ...(d.description !== undefined && { description: d.description?.trim() || null }),
      ...(d.is_medication !== undefined && { is_medication: d.is_medication }), ...(d.is_sentinel !== undefined && { is_sentinel: d.is_sentinel }),
      ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }) })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'QM_CLASSIFIER_UPDATE', entityName: 'qm_classifiers', entityId: id, oldData: old, newData: d });
    return row;
  }
}

@Controller('quality/classifiers')
export class QmCatalogController {
  constructor(private readonly s: QmCatalogService) {}
  @Get() list(@Query('kind') kind?: string, @Query('all') all?: string) { return this.s.list(kind, all === 'true'); }
  @Post() @Roles(...QM_FULL) create(@Body() d: ClassifierDto, @Req() req: Request) { return this.s.create(d, req); }
  @Patch(':id') @Roles(...QM_FULL) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ClassifierPatchDto, @Req() req: Request) { return this.s.update(id, d, req); }
}
