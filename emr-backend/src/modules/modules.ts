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

const classes = (v: unknown) => Array.isArray(v) && v.length <= 4 && v.every((x) => ['narcotic', 'psychotropic', 'precursor', 'potent'].includes(x as string)) && new Set(v).size === v.length;
const VALIDATORS: Record<string, { keys: Record<string, (v: unknown) => boolean>; extra?: Validator }> = {
  inpatient: {
    keys: {
      bed_assign_mode: (v) => oneOf(v, ['two_step', 'direct']), cleaning_required: bool, sex_rule: (v) => oneOf(v, ['block', 'warn', 'off']), overflow_beds: bool,
      planned_queue: bool, planned_sms: bool, cancel_hours: (v) => int(v, 0, 168),
      wristband: bool, wristband_print: (v) => oneOf(v, ['zpl', 'pdf']), wristband_width_mm: (v) => int(v, 15, 40), wristband_length_mm: (v) => int(v, 80, 400), wristband_offset_mm: (v) => int(v, 0, 200),
      // 0041: გადაყვანა / ეპიკრიზი / გაწერა / დროებითი გასვლა
      transfer_wait_hours: (v) => int(v, 1, 72), epicrisis_cosign: bool, discharge_cancel_hours: (v) => int(v, 0, 168), leave_counts_bed_day: bool,
      leave_max_hours: (v) => int(v, 1, 336), docs_pending_alert_hours: (v) => int(v, 1, 720),
    },
    extra: async (s) => ((s.wristband_length_mm as number) - (s.wristband_offset_mm as number) < 90 ? 'სამაჯურის ბეჭდვის ზონა (სიგრძე − საკეტის ზონა) მინიმუმ 90 მმ უნდა იყოს' : null),
  },
  cssd: {
    keys: {
      instrument_tracking: bool, cycle_entry: (v) => oneOf(v, ['manual']), wash_record: bool, bd_required: bool, bi_frequency: (v) => oneOf(v, ['each', 'daily', 'weekly', 'off']),
      bi_hold: (v) => oneOf(v, ['all', 'implant', 'none']), shelf_life_mode: (v) => oneOf(v, ['time', 'event']), patient_trace: bool, auto_consume: bool,
      label_size: (v) => oneOf(v, ['50x25', '40x20', '70x35']), label_code: (v) => oneOf(v, ['qr', 'code128']),
    },
  },
  stock: {
    keys: {
      issue_mode: (v) => oneOf(v, ['two_step', 'one_step']), witness_classes: classes, empty_return_classes: classes, dose_required: bool, count_lock: bool, count_blind_default: bool,
      pharmacist_scope: (v) => oneOf(v, ['pharmacy', 'any']), lost_requires_approval: bool, alert_expiry: bool, alert_minmax: bool, alert_lab: bool,
    },
  },
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
    if (dto.enabled === false && !m.can_disable) throw new BadRequestException(`მოდული „${m.name}“ არ ითიშება`);
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
