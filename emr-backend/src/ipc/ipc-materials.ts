import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IpcCommon } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class GroupDto {
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,19}$/) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @Length(1, 12) unit_label?: string;
  @IsOptional() @IsIn([1, 10, 100, 1000]) per_days?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) target?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(9999) sort_order?: number;
}
class ItemDto {
  @IsUUID() item_id: string;
  @IsNumber() @Min(0.000001) factor: number;
}
class ItemsDto { @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[] }

/**
 * IPC მასალები (0071): ჯგუფი (ხელის ანტისეპტიკი, ხელთათმანი…) = საწყობის საქონელი × კოეფიციენტი (საბაზო ერთეული → ჯგუფის ერთეული).
 *  • ხარჯი — განყოფილებაზე მიბმული ლოკაციები (stock_locations.department_id):
 *      material_source = issue — გაცემა / გადატანა / დაბრუნება (ნეტო შემოსვლა); consumption — ხარჯი + ჩამოწერა (სტორნო — აკლდება);
 *  • მნიშვნელი — პაციენტ-დღე (rpt_fact_ipc_daily); მაჩვენებელი = რაოდენობა / პაციენტ-დღე × per_days; სამიზნე — მინიმუმი.
 */
@Injectable()
export class IpcMaterialsService {
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async groups() {
    await this.c.rules();
    const [gs, items] = await Promise.all([
      this.db.selectFrom('ipc_material_groups').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('ipc_material_items as mi').innerJoin('stock_items as i', 'i.id', 'mi.item_id')
        .select(['mi.group_id', 'mi.item_id', 'mi.factor', 'i.code', 'i.name', 'i.base_unit', 'i.is_active']).orderBy('i.name').execute(),
    ]);
    return gs.map((g) => ({ ...g, items: items.filter((x) => x.group_id === g.id).map(({ group_id: _g, ...x }) => ({ ...x, factor: Number(x.factor) })) }));
  }

  async createGroup(d: GroupDto, req: Request) {
    await this.c.rules();
    if (!d.code || !d.name || !d.unit_label) throw new BadRequestException({ code: 'REQUIRED', message: 'კოდი, სახელი და ერთეული სავალდებულოა' });
    const dup = await this.db.selectFrom('ipc_material_groups').select('id').where('code', '=', d.code).executeTakeFirst();
    if (dup) throw new ConflictException({ code: 'DUPLICATE', message: 'ასეთი კოდი უკვე არსებობს' });
    const r = await this.db.insertInto('ipc_material_groups').values({ code: d.code, name: d.name.trim(), unit_label: d.unit_label.trim(), per_days: d.per_days ?? 1000,
      target: d.target ?? null, is_active: d.is_active ?? true, sort_order: d.sort_order ?? 100 }).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'IPC_MATERIAL_GROUP_CREATE', entityName: 'ipc_material_groups', entityId: r.id, newData: d });
    return r;
  }

  async updateGroup(id: string, d: GroupDto, req: Request) {
    await this.c.rules();
    const ex = await this.db.selectFrom('ipc_material_groups').selectAll().where('id', '=', id).executeTakeFirst();
    if (!ex) throw new NotFoundException('ჯგუფი ვერ მოიძებნა');
    if (d.code !== undefined && d.code !== ex.code) throw new BadRequestException({ code: 'CODE_FIXED', message: 'კოდი არ იცვლება' });
    const vals = Object.fromEntries(Object.entries({ name: d.name?.trim(), unit_label: d.unit_label?.trim(), per_days: d.per_days, target: d.target, is_active: d.is_active,
      sort_order: d.sort_order }).filter(([, v]) => v !== undefined));
    if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
    const r = await this.db.updateTable('ipc_material_groups').set(vals).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'IPC_MATERIAL_GROUP_UPDATE', entityName: 'ipc_material_groups', entityId: id,
      oldData: Object.fromEntries(Object.keys(vals).map((k) => [k, (ex as Record<string, unknown>)[k]])), newData: vals });
    return r;
  }

  /** ჯგუფის საქონელი — სრული ჩანაცვლება */
  async setItems(id: string, d: ItemsDto, req: Request) {
    await this.c.rules();
    const g = await this.db.selectFrom('ipc_material_groups').select('id').where('id', '=', id).executeTakeFirst();
    if (!g) throw new NotFoundException('ჯგუფი ვერ მოიძებნა');
    const ids = d.items.map((x) => x.item_id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException({ code: 'DUPLICATE', message: 'საქონელი ორჯერაა მითითებული' });
    if (ids.length) {
      const n = (await this.db.selectFrom('stock_items').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).executeTakeFirstOrThrow()).n;
      if (n !== ids.length) throw new BadRequestException({ code: 'ITEM_NOT_FOUND', message: 'საქონელი ვერ მოიძებნა' });
    }
    const old = await this.db.selectFrom('ipc_material_items').select(['item_id', 'factor']).where('group_id', '=', id).execute();
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('ipc_material_items').where('group_id', '=', id).execute();
      if (d.items.length) await trx.insertInto('ipc_material_items').values(d.items.map((x) => ({ group_id: id, item_id: x.item_id, factor: String(x.factor) }))).execute();
    });
    await this.audit.log(auditCtx(req), { action: 'IPC_MATERIAL_ITEMS_SET', entityName: 'ipc_material_groups', entityId: id,
      oldData: { items: old.map((x) => ({ item_id: x.item_id, factor: Number(x.factor) })) }, newData: { items: d.items } });
    return (await this.groups()).find((x) => x.id === id);
  }

  /** საწყობის საქონლის ძებნა (ჯგუფში დასამატებლად) */
  async searchItems(q?: string) {
    await this.c.rules();
    if (!q || q.trim().length < 2) return [];
    const s = `%${q.trim().toLowerCase()}%`;
    return this.db.selectFrom('stock_items').select(['id', 'code', 'name', 'base_unit']).where('is_active', '=', true)
      .where((eb) => eb.or([eb(sql`lower(name)`, 'like', s), eb(sql`lower(code)`, 'like', s)])).orderBy('name').limit(30).execute();
  }

  async rates(u: AuthUser, q: { from?: string; to?: string; department_id?: string }) {
    const r = await this.c.rules();
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    const sc = await this.c.scope(u);
    if (q.department_id && !sc.full && !sc.depts.includes(q.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
    const depts = q.department_id ? [q.department_id] : sc.full ? null : sc.depts;
    const dcond = (col: string) => (depts ? sql`AND ${sql.ref(col)} = ANY(${sql.val(depts)}::uuid[])` : sql``);
    const types = r.material_source === 'issue' ? ['transfer', 'issue', 'return'] : ['consumption', 'writeoff'];
    const sign = r.material_source === 'issue' ? 1 : -1;
    const use = (await sql<{ group_id: string; department_id: string; ym: string; qty: string }>`
      SELECT mi.group_id, l.department_id, to_char((m.created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM') AS ym, (${sign} * sum(m.qty * mi.factor))::text AS qty
        FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id JOIN ipc_material_items mi ON mi.item_id = m.item_id
       WHERE l.department_id IS NOT NULL AND m.move_type = ANY(${sql.val(types)}::text[])
         AND (m.created_at AT TIME ZONE ${TZ})::date BETWEEN ${q.from}::date AND ${q.to}::date ${dcond('l.department_id')}
       GROUP BY 1, 2, 3`.execute(this.db)).rows;
    const pd = (await sql<{ department_id: string; department: string; ym: string; patient_days: number }>`
      SELECT f.department_id, d.name AS department, to_char(f.day, 'YYYY-MM') AS ym, sum(f.patient_days)::int AS patient_days
        FROM rpt_fact_ipc_daily f JOIN departments d ON d.id = f.department_id
       WHERE f.day BETWEEN ${q.from}::date AND ${q.to}::date ${dcond('f.department_id')} GROUP BY 1, 2, 3`.execute(this.db)).rows;
    const dnames = new Map<string, string>(pd.map((x) => [x.department_id, x.department]));
    const missing = [...new Set(use.map((x) => x.department_id).filter((id) => !dnames.has(id)))];
    if (missing.length) (await this.db.selectFrom('departments').select(['id', 'name']).where('id', 'in', missing).execute()).forEach((d) => dnames.set(d.id, d.name));
    const months = [...new Set([...pd.map((x) => x.ym), ...use.map((x) => x.ym)])].sort();
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const rate = (qty: number, days: number, per: number) => (days > 0 ? Math.round((qty / days) * per * 100) / 100 : null);
    const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
    const totalPd = sum(pd, (x) => x.patient_days);
    const gs = (await this.groups()).filter((g) => g.is_active);
    const groups = gs.map((g) => {
      const gu = use.filter((x) => x.group_id === g.id);
      const qty = sum(gu, (x) => Number(x.qty));
      const deptIds = [...new Set([...pd.map((x) => x.department_id), ...gu.map((x) => x.department_id)])];
      return {
        id: g.id, code: g.code, name: g.name, unit_label: g.unit_label, per_days: g.per_days, target: g.target === null ? null : Number(g.target), items: g.items.length,
        qty: r3(qty), rate: rate(qty, totalPd, g.per_days),
        months: months.map((m) => { const q2 = sum(gu.filter((x) => x.ym === m), (x) => Number(x.qty)); const d2 = sum(pd.filter((x) => x.ym === m), (x) => x.patient_days);
          return { ym: m, qty: r3(q2), patient_days: d2, rate: rate(q2, d2, g.per_days) }; }),
        departments: deptIds.map((id) => { const q2 = sum(gu.filter((x) => x.department_id === id), (x) => Number(x.qty)); const d2 = sum(pd.filter((x) => x.department_id === id), (x) => x.patient_days);
          return { department_id: id, department: dnames.get(id) ?? '—', qty: r3(q2), patient_days: d2, rate: rate(q2, d2, g.per_days) }; })
          .sort((a, b) => a.department.localeCompare(b.department)),
      };
    });
    return { from: q.from, to: q.to, source: r.material_source, patient_days: totalPd, groups };
  }
}

@Controller('ipc/materials')
export class IpcMaterialsController {
  constructor(private readonly s: IpcMaterialsService) {}
  @Get('groups') @Roles(...IPC_ANY) groups() { return this.s.groups(); }
  @Post('groups') @Roles(...IPC_FULL) create(@Body() d: GroupDto, @Req() r: Request) { return this.s.createGroup(d, r); }
  @Patch('groups/:id') @Roles(...IPC_FULL) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: GroupDto, @Req() r: Request) { return this.s.updateGroup(id, d, r); }
  @Put('groups/:id/items') @Roles(...IPC_FULL) items(@Param('id', ParseUUIDPipe) id: string, @Body() d: ItemsDto, @Req() r: Request) { return this.s.setItems(id, d, r); }
  @Get('stock-items') @Roles(...IPC_FULL) search(@Query('q') q?: string) { return this.s.searchItems(q); }
  @Get('rates') @Roles(...IPC_ANY) rates(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('department_id') department_id?: string) {
    return this.s.rates(u, { from, to, department_id });
  }
}
