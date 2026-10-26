import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { BME_FULL, BME_VIEW_ALL, userName, type BmeSettings, type Ex } from './bme-common';
import { today } from './bme-pm-common';
import { CONTRACT_KA, CONTRACT_KINDS, coverage, devEvent, type ContractKind } from './bme-repair-common';

/** კონტრაქტების ნახვა: რეესტრის სრული ხედვა + შესყიდვები / ბუღალტერია */
const CT_VIEW: Role[] = [...BME_VIEW_ALL, 'procurement', 'procurement_approve', 'accountant'];
const VIEWS = ['active', 'expiring', 'expired', 'cancelled', 'all'] as const;

/**
 * ბიომედ-აპარატურა, ეტაპი 3 (0075): სერვისის კონტრაქტები — მომწოდებელი, სახე, პერიოდი, ღირებულება, SLA (რეაგირება / აღდგენა P1–P4), uptime, PM ვიზიტები,
 *  დაფარული სამუშაოს სახეები (0074), აპარატები (M:N), ფაილები. ქარხნული გარანტია — პასპორტის ველი.
 */
@Injectable()
export class ContractService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly storage: StorageService) {}

  private settings() { return this.modules.require<BmeSettings>('bme'); }
  private view(u: AuthUser) { if (!has(u, ...CT_VIEW)) throw new ForbiddenException('კონტრაქტები — ბიომედ-აპარატურის / შესყიდვების ნახვის უფლება'); }

  private q(ex: Ex = this.db) {
    return ex.selectFrom('bme_contracts as c').innerJoin('stock_suppliers as s', 's.id', 'c.supplier_id').leftJoin('users as cu', 'cu.id', 'c.created_by')
      .selectAll('c').select(['s.name as supplier_name', 's.phone as supplier_phone', userName('cu').as('created_by_name'),
        sql<number>`(SELECT count(*)::int FROM bme_contract_devices cd WHERE cd.contract_id = c.id)`.as('devices'),
        sql<number>`(c.end_date - ${today()})::int`.as('days_left'),
        sql<boolean>`c.status = 'active' AND ${today()} BETWEEN c.start_date AND c.end_date`.as('in_force'),
        // ღირებულება წელიწადში (შედარებისთვის)
        sql<string | null>`CASE c.cost_period WHEN 'month' THEN c.cost * 12 WHEN 'quarter' THEN c.cost * 4 WHEN 'year' THEN c.cost
          WHEN 'once' THEN round(c.cost / GREATEST(1, ((c.end_date - c.start_date) + 1) / 365.25), 2) END::text`.as('annual_cost')]);
  }

  async list(u: AuthUser, q: { view?: string; supplier_id?: string; search?: string; device_id?: string }) {
    this.view(u);
    await this.settings();
    const view = (VIEWS as readonly string[]).includes(q.view ?? '') ? q.view : 'active';
    let x = this.q().orderBy('c.end_date').limit(1000);
    if (view === 'active') x = x.where('c.status', '=', 'active').where('c.end_date', '>=', today());
    else if (view === 'expiring') x = x.where('c.status', '=', 'active').where('c.end_date', '>=', today()).where('c.end_date', '<=', sql<string>`${today()} + 90`);
    else if (view === 'expired') x = x.where('c.status', '=', 'active').where('c.end_date', '<', today());
    else if (view === 'cancelled') x = x.where('c.status', '=', 'cancelled');
    if (q.supplier_id) x = x.where('c.supplier_id', '=', q.supplier_id);
    if (q.device_id) x = x.where(sql<boolean>`EXISTS (SELECT 1 FROM bme_contract_devices cd WHERE cd.contract_id = c.id AND cd.device_id = ${q.device_id})`);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(c.contract_no)`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(c.title)`, 'like', `%${s.toLowerCase()}%`), eb(sql`lower(s.name)`, 'like', `%${s.toLowerCase()}%`)]));
    return x.execute();
  }

  async get(id: string, u: AuthUser) {
    this.view(u);
    await this.settings();
    const c = await this.q().where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('კონტრაქტი ვერ მოიძებნა');
    const [devices, files, kinds, repairs] = await Promise.all([
      this.db.selectFrom('bme_contract_devices as cd').innerJoin('bme_devices as b', 'b.id', 'cd.device_id').innerJoin('bme_device_types as t', 't.id', 'b.type_id').leftJoin('departments as d', 'd.id', 'b.department_id')
        .select(['b.id', 'b.inv_no', 'b.name', 'b.status', 'b.serial_no', 'b.warranty_until', 't.name as type_name', 'd.name as department_name', 'cd.added_at']).where('cd.contract_id', '=', id).orderBy('b.inv_no').execute(),
      this.db.selectFrom('bme_contract_files').select(['id', 'title', 'mime_type', 'size_bytes', 'original_name', 'created_at']).where('contract_id', '=', id).where('is_active', '=', true).orderBy('created_at').execute(),
      c.covers_kinds.length ? this.db.selectFrom('bme_work_kinds').select(['id', 'code', 'short_name']).where('id', 'in', c.covers_kinds).execute() : Promise.resolve([]),
      // ორდერები ამ კონტრაქტით (SLA-ს შესრულება)
      this.db.selectFrom('bme_repairs as r').innerJoin('bme_devices as b', 'b.id', 'r.device_id')
        .select(['r.id', 'r.repair_no', 'r.status', 'r.priority', 'r.reported_at', 'r.vendor_called_at', 'r.vendor_arrived_at', 'r.done_at', 'r.sla_response_due', 'r.sla_restore_due', 'b.inv_no', 'b.name as device_name',
          sql<boolean | null>`CASE WHEN r.sla_response_due IS NULL THEN NULL WHEN r.vendor_arrived_at IS NOT NULL THEN r.vendor_arrived_at <= r.sla_response_due ELSE now() <= r.sla_response_due END`.as('response_ok'),
          sql<boolean | null>`CASE WHEN r.sla_restore_due IS NULL THEN NULL WHEN r.done_at IS NOT NULL THEN r.done_at <= r.sla_restore_due ELSE now() <= r.sla_restore_due END`.as('restore_ok')])
        .where('r.contract_id', '=', id).orderBy('r.reported_at', 'desc').limit(200).execute(),
    ]);
    return { ...c, devices, files, covers: kinds, repairs };
  }

  private check(dto: ContractDto, partial: boolean) {
    if (!partial && (!dto.contract_no || !dto.title || !dto.supplier_id || !dto.kind || !dto.start_date || !dto.end_date)) throw new BadRequestException('№, დასახელება, მომწოდებელი, სახე და პერიოდი სავალდებულოა');
    if (dto.start_date && dto.end_date && dto.end_date < dto.start_date) throw new BadRequestException('დასასრული დასაწყისზე ადრეა');
    if ((dto.cost === undefined) !== (dto.cost_period === undefined) && !partial) throw new BadRequestException('ღირებულება და პერიოდულობა — ერთად');
    for (const k of ['response_hours', 'restore_hours'] as const) {
      const v = dto[k];
      if (v && (v.length !== 4 || v.some((x, i) => i > 0 && x < v[i - 1]))) throw new BadRequestException(`${k === 'response_hours' ? 'რეაგირების' : 'აღდგენის'} საათები — 4 მნიშვნელობა (P1 ≤ P2 ≤ P3 ≤ P4)`);
    }
    if (dto.response_hours && dto.restore_hours && dto.response_hours.some((x, i) => x > dto.restore_hours![i])) throw new BadRequestException('რეაგირების დრო აღდგენის დროზე მეტია');
  }
  private vals(dto: ContractDto) {
    return {
      ...(dto.contract_no !== undefined && { contract_no: dto.contract_no.trim() }), ...(dto.title !== undefined && { title: dto.title.trim() }),
      ...(dto.supplier_id !== undefined && { supplier_id: dto.supplier_id }), ...(dto.kind !== undefined && { kind: dto.kind }),
      ...(dto.start_date !== undefined && { start_date: dto.start_date }), ...(dto.end_date !== undefined && { end_date: dto.end_date }),
      ...(dto.cost !== undefined && { cost: dto.cost === null ? null : String(dto.cost) }), ...(dto.cost_period !== undefined && { cost_period: dto.cost_period }),
      ...(dto.response_hours !== undefined && { response_hours: dto.response_hours }), ...(dto.restore_hours !== undefined && { restore_hours: dto.restore_hours }),
      ...(dto.uptime_pct !== undefined && { uptime_pct: dto.uptime_pct === null ? null : String(dto.uptime_pct) }), ...(dto.pm_visits_per_year !== undefined && { pm_visits_per_year: dto.pm_visits_per_year }),
      ...(dto.covers_kinds !== undefined && { covers_kinds: dto.covers_kinds }), ...(dto.covers_parts !== undefined && { covers_parts: dto.covers_parts }),
      ...(dto.contact !== undefined && { contact: dto.contact?.trim() || null }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
    };
  }
  private async refsOk(ex: Ex, dto: ContractDto) {
    if (dto.supplier_id && !(await ex.selectFrom('stock_suppliers').select('id').where('id', '=', dto.supplier_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('მომწოდებელი ვერ მოიძებნა ან გათიშულია');
    if (dto.covers_kinds?.length) {
      const n = (await ex.selectFrom('bme_work_kinds').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', dto.covers_kinds).executeTakeFirstOrThrow()).n;
      if (n !== new Set(dto.covers_kinds).size) throw new BadRequestException('სამუშაოს სახე ვერ მოიძებნა');
    }
  }
  private pg(e: unknown): never {
    const c = (e as { constraint?: string }).constraint;
    if (c === 'ux_bme_contract_no') throw new ConflictException('ამ მომწოდებელთან იგივე №-ის კონტრაქტი უკვე არსებობს');
    if (c === 'bme_contracts_check2') throw new BadRequestException('ღირებულება და პერიოდულობა — ერთად');
    throw e;
  }

  async create(dto: ContractDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    this.check(dto, false);
    if ((dto.cost ?? null) === null !== ((dto.cost_period ?? null) === null)) throw new BadRequestException('ღირებულება და პერიოდულობა — ერთად');
    let id = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        await this.refsOk(trx, dto);
        const c = await trx.insertInto('bme_contracts').values({ ...this.vals(dto), contract_no: dto.contract_no!.trim(), title: dto.title!.trim(), supplier_id: dto.supplier_id!, kind: dto.kind!,
          start_date: dto.start_date!, end_date: dto.end_date!, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        id = c.id;
        if (dto.device_ids?.length) await this.addDevicesTrx(trx, id, dto.device_ids, u);
        await this.audit.log(ctx, { action: 'CREATE_BME_CONTRACT', entityName: 'bme_contracts', entityId: id, newData: dto }, trx);
      });
    } catch (e) { this.pg(e); }
    return this.get(id, u);
  }

  async update(id: string, dto: ContractDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    this.check(dto, true);
    try {
      await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('bme_contracts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('კონტრაქტი ვერ მოიძებნა');
        if (old.status === 'cancelled') throw new ConflictException('კონტრაქტი გაუქმებულია');
        const sd = dto.start_date ?? old.start_date; const ed = dto.end_date ?? old.end_date;
        if (String(ed) < String(sd)) throw new BadRequestException('დასასრული დასაწყისზე ადრეა');
        await this.refsOk(trx, dto);
        await trx.updateTable('bme_contracts').set({ ...this.vals(dto), updated_at: sql`now()` }).where('id', '=', id).execute();
        // ვადის გაგრძელება → შეხსენებები თავიდან (ახალ ვადაზე)
        await this.audit.log(ctx, { action: 'UPDATE_BME_CONTRACT', entityName: 'bme_contracts', entityId: id, oldData: old, newData: dto }, trx);
      });
    } catch (e) { this.pg(e); }
    return this.get(id, u);
  }

  async cancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('bme_contracts').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('კონტრაქტი ვერ მოიძებნა');
      if (c.status === 'cancelled') throw new ConflictException('უკვე გაუქმებულია');
      await trx.updateTable('bme_contracts').set({ status: 'cancelled', cancel_reason: reason.trim(), updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'CANCEL_BME_CONTRACT', entityName: 'bme_contracts', entityId: id, newData: { reason } }, trx);
    });
    return this.get(id, u);
  }

  private async addDevicesTrx(trx: Ex, id: string, ids: string[], u: AuthUser) {
    const devs = await trx.selectFrom('bme_devices').select(['id', 'status']).where('id', 'in', ids).execute();
    if (devs.length !== new Set(ids).size) throw new BadRequestException('აპარატი ვერ მოიძებნა');
    if (devs.some((d) => d.status === 'retired')) throw new BadRequestException('გამოყვანილი აპარატი კონტრაქტს არ ემატება');
    const c = await trx.selectFrom('bme_contracts').select(['contract_no', 'kind']).where('id', '=', id).executeTakeFirstOrThrow();
    const added = await trx.insertInto('bme_contract_devices').values(ids.map((d) => ({ contract_id: id, device_id: d, added_by: u.id }))).onConflict((oc) => oc.doNothing()).returning('device_id').execute();
    for (const a of added) await devEvent(trx, a.device_id, 'contract', { action: 'added', contract_id: id, contract_no: c.contract_no, kind: c.kind }, u.id);
    return added.length;
  }
  async addDevices(id: string, ids: string[], u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('bme_contracts').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('კონტრაქტი ვერ მოიძებნა');
      if (c.status === 'cancelled') throw new ConflictException('კონტრაქტი გაუქმებულია');
      const n = await this.addDevicesTrx(trx, id, ids, u);
      await this.audit.log(ctx, { action: 'BME_CONTRACT_DEVICES', entityName: 'bme_contracts', entityId: id, newData: { added: ids, count: n } }, trx);
    });
    return this.get(id, u);
  }
  async removeDevice(id: string, deviceId: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('bme_contracts').select(['contract_no']).where('id', '=', id).executeTakeFirst();
      if (!c) throw new NotFoundException('კონტრაქტი ვერ მოიძებნა');
      const r = await trx.deleteFrom('bme_contract_devices').where('contract_id', '=', id).where('device_id', '=', deviceId).executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw new NotFoundException('აპარატი კონტრაქტში არ არის');
      await devEvent(trx, deviceId, 'contract', { action: 'removed', contract_id: id, contract_no: c.contract_no }, u.id);
      await this.audit.log(ctx, { action: 'BME_CONTRACT_DEVICE_REMOVE', entityName: 'bme_contracts', entityId: id, newData: { device_id: deviceId } }, trx);
    });
    return this.get(id, u);
  }

  async upload(id: string, file: Express.Multer.File | undefined, title: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი "file")');
    const c = await this.db.selectFrom('bme_contracts').select(['id', 'contract_no']).where('id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('კონტრაქტი ვერ მოიძებნა');
    const mime = sniffMime(file.buffer);
    if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: 'დაშვებულია მხოლოდ PDF, JPG ან PNG' });
    const fid = randomUUID(); const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    const key = `bme/contracts/${id}/${fid}.${ext}`;
    await this.storage.put(key, file.buffer, mime);
    const name = Buffer.from(file.originalname ?? '', 'latin1').toString('utf8').slice(0, 200) || null;
    await this.db.insertInto('bme_contract_files').values({ id: fid, contract_id: id, title: (title?.trim() || name || `კონტრაქტი ${c.contract_no}`).slice(0, 200), file_path: key, mime_type: mime,
      size_bytes: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex'), original_name: name, uploaded_by: u.id }).execute();
    await this.audit.log(ctx, { action: 'BME_CONTRACT_FILE', entityName: 'bme_contracts', entityId: id, newData: { file: fid } });
    return this.get(id, u);
  }
  async file(id: string, fid: string, u: AuthUser) {
    this.view(u);
    const f = await this.db.selectFrom('bme_contract_files').select(['file_path', 'mime_type']).where('id', '=', fid).where('contract_id', '=', id).where('is_active', '=', true).executeTakeFirst();
    if (!f) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    return { stream: await this.storage.get(f.file_path), mime: f.mime_type };
  }

  /** აპარატის დაფარვა (ორდერის ფორმისთვის) */
  async coverage(deviceId: string, u: AuthUser) {
    if (!has(u, ...BME_FULL, ...CT_VIEW)) throw new ForbiddenException('დაფარვა — ბიომედ-აპარატურის უფლება');
    await this.settings();
    return coverage(this.db, deviceId);
  }
}

// ======================================================================= DTO
class ContractDto {
  @IsOptional() @IsString() @Length(1, 60) contract_no?: string; @IsOptional() @IsString() @Length(2, 300) title?: string; @IsOptional() @IsUUID() supplier_id?: string;
  @IsOptional() @IsIn(CONTRACT_KINDS) kind?: ContractKind; @IsOptional() @IsISO8601({ strict: true }) start_date?: string; @IsOptional() @IsISO8601({ strict: true }) end_date?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1e9) cost?: number | null; @IsOptional() @IsIn(['once', 'month', 'quarter', 'year', null]) cost_period?: 'once' | 'month' | 'quarter' | 'year' | null;
  @IsOptional() @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4) @IsInt({ each: true }) @Min(1, { each: true }) @Max(2000, { each: true }) response_hours?: number[] | null;
  @IsOptional() @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4) @IsInt({ each: true }) @Min(1, { each: true }) @Max(2000, { each: true }) restore_hours?: number[] | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uptime_pct?: number | null; @IsOptional() @IsInt() @Min(0) @Max(52) pm_visits_per_year?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) covers_kinds?: string[]; @IsOptional() @IsBoolean() covers_parts?: boolean;
  @IsOptional() @IsString() @MaxLength(300) contact?: string | null; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) device_ids?: string[];
}
class DevicesDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) device_ids: string[] }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** სერვისის კონტრაქტები (0075) */
@Controller('bme')
export class ContractController {
  constructor(private readonly s: ContractService) {}
  @Get('contracts/kinds') kinds() { return CONTRACT_KA; }
  @Get('contracts') list(@CurrentUser() u: AuthUser, @Query() q: { view?: string; supplier_id?: string; search?: string; device_id?: string }) {
    if (!uuidOk(q.supplier_id) || !uuidOk(q.device_id)) throw new BadRequestException('არასწორი id');
    return this.s.list(u, q);
  }
  @Post('contracts') @Roles(...BME_FULL) create(@Body() d: ContractDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Get('contracts/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Patch('contracts/:id') @Roles(...BME_FULL) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ContractDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (d.device_ids !== undefined) throw new BadRequestException('აპარატები — ცალკე (/devices)');
    return this.s.update(id, d, u, auditCtx(r));
  }
  @Post('contracts/:id/cancel') @HttpCode(200) @Roles(...BME_FULL) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, u, auditCtx(r)); }
  @Post('contracts/:id/devices') @HttpCode(200) @Roles(...BME_FULL) add(@Param('id', ParseUUIDPipe) id: string, @Body() d: DevicesDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addDevices(id, d.device_ids, u, auditCtx(r)); }
  @Post('contracts/:id/devices/:deviceId/remove') @HttpCode(200) @Roles(...BME_FULL)
  remove(@Param('id', ParseUUIDPipe) id: string, @Param('deviceId', ParseUUIDPipe) deviceId: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removeDevice(id, deviceId, u, auditCtx(r)); }
  @Post('contracts/:id/files') @Roles(...BME_FULL) @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() f: Express.Multer.File | undefined, @Body() b: { title?: string }, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.upload(id, f, b?.title, u, auditCtx(r)); }
  @Get('contracts/:id/files/:fid')
  async file(@Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const f = await this.s.file(id, fid, u);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(f.stream);
  }
  @Get('devices/:id/coverage') cov(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.coverage(id, u); }
}
