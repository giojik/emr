import { BadRequestException, Body, Controller, ForbiddenException, Get, Global, Injectable, Module, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';

/**
 * მოდულები და პარამეტრები (0037): კლინიკა რთავს / თიშავს მოდულს და ცვლის მის პარამეტრებს.
 * თითო მოდულს — ვალიდატორი: უცნობი გასაღები ან არასწორი მნიშვნელობა → 400; ნაგულისხმევები — migration-ის seed-ში.
 */
type Validator = (s: Record<string, unknown>, db: Database) => Promise<string | null>;
const bool = (v: unknown) => typeof v === 'boolean';
const int = (v: unknown, a: number, b: number) => Number.isInteger(v) && (v as number) >= a && (v as number) <= b;
const oneOf = (v: unknown, xs: string[]) => typeof v === 'string' && xs.includes(v);

const VALIDATORS: Record<string, { keys: Record<string, (v: unknown) => boolean>; extra?: Validator }> = {
  asset_register: {
    keys: {
      inv_prefix: (v) => typeof v === 'string' && /^[A-Z0-9]{0,8}$/.test(v),
      inv_year: bool, inv_digits: (v) => int(v, 3, 9), require_room: bool, require_responsible: bool,
      move_mode: (v) => oneOf(v, ['direct', 'confirm']), writeoff_mode: (v) => oneOf(v, ['direct', 'single', 'committee']),
      writeoff_committee: (v) => Array.isArray(v) && v.length <= 15 && v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)),
      committee_quorum: (v) => int(v, 1, 15), track_value: bool,
      label_size: (v) => oneOf(v, ['50x25', '40x20', '70x35']), label_code: (v) => oneOf(v, ['qr', 'code128']),
    },
    extra: async (s, db) => {
      if (s.writeoff_mode === 'committee') {
        const ids = (s.writeoff_committee as string[]) ?? [];
        if (ids.length < ((s.committee_quorum as number) ?? 1)) return 'კომისიის წევრების რაოდენობა კვორუმზე ნაკლებია';
        const n = ids.length ? (await db.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).where('is_active', '=', true).executeTakeFirstOrThrow()).n : 0;
        if (n !== ids.length) return 'კომისიის წევრი ვერ მოიძებნა ან გათიშულია';
      }
      return null;
    },
  },
};

@Injectable()
export class ModulesService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  list() { return this.db.selectFrom('system_modules').selectAll().orderBy('sort_order').execute(); }

  async get(code: string) {
    const m = await this.db.selectFrom('system_modules').selectAll().where('code', '=', code).executeTakeFirst();
    if (!m) throw new NotFoundException('მოდული ვერ მოიძებნა');
    return m;
  }
  /** მოდულის პარამეტრები; გამორთულზე — 403 */
  async require<T = Record<string, unknown>>(code: string): Promise<T> {
    const m = await this.get(code);
    if (!m.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: `მოდული „${m.name}“ გამორთულია (ადმინისტრირება → მოდულები)` });
    return m.settings as T;
  }

  async put(code: string, dto: { enabled?: boolean; settings?: Record<string, unknown>; reason: string }, u: AuthUser, req: Request) {
    const m = await this.get(code);
    const v = VALIDATORS[code];
    let settings = m.settings as Record<string, unknown>;
    if (dto.settings) {
      if (!v) throw new BadRequestException('ამ მოდულს პარამეტრები არ აქვს');
      for (const [k, val] of Object.entries(dto.settings)) {
        if (!v.keys[k]) throw new BadRequestException(`უცნობი პარამეტრი: ${k}`);
        if (!v.keys[k](val)) throw new BadRequestException(`არასწორი მნიშვნელობა: ${k}`);
      }
      settings = { ...settings, ...dto.settings };
      const err = v.extra ? await v.extra(settings, this.db) : null;
      if (err) throw new BadRequestException(err);
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('system_modules').set({ ...(dto.enabled !== undefined && { enabled: dto.enabled }), settings: JSON.stringify(settings), updated_by: u.id, updated_at: sql`now()` })
        .where('code', '=', code).execute();
      await this.audit.log(auditCtx(req), { action: 'UPDATE_MODULE', entityName: 'system_modules', entityId: code,
        oldData: { enabled: m.enabled, settings: m.settings }, newData: { enabled: dto.enabled ?? m.enabled, settings, reason: dto.reason } }, trx);
    });
    return this.get(code);
  }
}

class ModuleDto { @IsOptional() @IsBoolean() enabled?: boolean; @IsOptional() @IsObject() settings?: Record<string, unknown>; @IsString() @Length(3, 500) reason: string }

@Controller('modules')
export class ModulesController {
  constructor(private readonly s: ModulesService) {}
  /** ყველა შესულ მომხმარებელს — მენიუ / ჩანართები მოდულის მიხედვით */
  @Get() list() { return this.s.list(); }
  @Put(':code') @Roles('admin') put(@Param('code') code: string, @Body() d: ModuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.put(code, d, u, r); }
}

@Global()
@Module({ providers: [ModulesService], controllers: [ModulesController], exports: [ModulesService] })
export class ModulesModule {}
