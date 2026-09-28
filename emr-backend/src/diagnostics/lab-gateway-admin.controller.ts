import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { LabAlertsService } from '../lab-gateway/lab-alerts.service';
import { NotifyService } from '../notify/notify.service';

class CommandDto {
  @IsIn(['tcp_test', 'link_test', 'reconnect']) kind: 'tcp_test' | 'link_test' | 'reconnect';
  @IsOptional() @IsUUID() method_id?: string;
  @IsOptional() @IsString() @MaxLength(255) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsIn(['astm', 'hl7']) protocol?: 'astm' | 'hl7';
}
class OptionsDto {
  @IsOptional() @IsBoolean() listen_only?: boolean;
  @IsOptional() @IsBoolean() alerts_enabled?: boolean;
  @IsOptional() @IsInt() @Min(10) @Max(10080) silent_minutes?: number | null;
}
class AlertSettingsDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(1) @Max(1440) disconnect_minutes: number;
  @IsInt() @Min(10) @Max(10080) silent_minutes: number;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) work_start: string;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) work_end: string;
  @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) work_days: number[];
  @IsArray() @ArrayMaxSize(10) @Matches(/^\+?\d{9,15}$/, { each: true, message: 'ტელეფონი: 9–15 ციფრი (მაგ. 5XXXXXXXX)' }) sms_phones: string[];
  @IsArray() @ArrayMaxSize(10) @IsEmail({}, { each: true }) emails: string[];
  @IsBoolean() notify_resolved: boolean;
}

/** ადმინისტრირება → ანალიზატორები (IT): დაფა, შემოწმება, ჟურნალი, აღმოჩენილი კოდები, გაფრთხილებები */
@Injectable()
export class LabGatewayAdminService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly alerts: LabAlertsService, private readonly notify: NotifyService) {}

  private instrumentOf(methodId: string) {
    return this.db.selectFrom('lab_instruments').selectAll().where('method_id', '=', methodId).executeTakeFirst();
  }

  async dashboard() {
    const today = sql<Date>`date_trunc('day', now() AT TIME ZONE ${this.tz}) AT TIME ZONE ${this.tz}`;
    const rows = await this.db.selectFrom('lab_methods as m').innerJoin('lab_instruments as i', 'i.method_id', 'm.id')
      .select(['m.id as method_id', 'm.name', 'm.is_active', 'i.id', 'i.protocol', 'i.conn_mode', 'i.host', 'i.port', 'i.is_enabled', 'i.order_mode', 'i.listen_only', 'i.alerts_enabled',
        'i.silent_minutes', 'i.status', 'i.status_at', 'i.down_since', 'i.peer', 'i.last_message_at', 'i.last_error',
        (eb) => eb.selectFrom('lab_instrument_results as r').select((e) => e.fn.countAll<number>().as('n')).whereRef('r.instrument_id', '=', 'i.id').where('r.created_at', '>=', today).as('results_today'),
        (eb) => eb.selectFrom('lab_instrument_results as r').select((e) => e.fn.countAll<number>().as('n')).whereRef('r.instrument_id', '=', 'i.id').where('r.status', '=', 'unmatched').as('unmatched'),
        (eb) => eb.selectFrom('lab_instrument_messages as g').select((e) => e.fn.countAll<number>().as('n')).whereRef('g.instrument_id', '=', 'i.id').where('g.created_at', '>=', today).where('g.kind', '=', 'query').as('queries_today'),
        (eb) => eb.selectFrom('lab_instrument_messages as g').select((e) => e.fn.countAll<number>().as('n')).whereRef('g.instrument_id', '=', 'i.id').where('g.created_at', '>=', today).where('g.direction', '=', 'out').where('g.kind', '=', 'orders').as('orders_today'),
        (eb) => eb.selectFrom('lab_instrument_messages as g').select((e) => e.fn.countAll<number>().as('n')).whereRef('g.instrument_id', '=', 'i.id').where('g.created_at', '>=', today).where('g.error', 'is not', null).as('errors_today'),
        (eb) => eb.selectFrom('lab_instrument_codes as c').select((e) => e.fn.countAll<number>().as('n')).whereRef('c.instrument_id', '=', 'i.id').as('codes'),
        (eb) => eb.selectFrom('lab_instrument_seen_codes as s').select((e) => e.fn.countAll<number>().as('n')).whereRef('s.instrument_id', '=', 'i.id')
          .where((e2) => e2.not(e2.exists(e2.selectFrom('lab_instrument_codes as c').select('c.id').whereRef('c.instrument_id', '=', 'i.id').where(sql`upper(c.code)`, '=', sql`upper(s.code)`)))).as('unmapped_codes')])
      .orderBy('i.is_enabled', 'desc').orderBy('m.name').execute();
    const g = await this.db.selectFrom('lab_gateway_state').selectAll().where('id', '=', 1).executeTakeFirst();
    const open = await this.db.selectFrom('lab_gateway_alerts as a').leftJoin('lab_instruments as i', 'i.id', 'a.instrument_id').leftJoin('lab_methods as m', 'm.id', 'i.method_id')
      .select(['a.id', 'a.kind', 'a.message', 'a.started_at', 'a.notified', 'm.id as method_id', 'm.name']).where('a.resolved_at', 'is', null).orderBy('a.started_at', 'desc').execute();
    return {
      gateway: { alive: !!g && Date.now() - new Date(g.heartbeat_at).getTime() < 90_000, heartbeat_at: g?.heartbeat_at ?? null, started_at: g?.started_at ?? null, hostname: g?.hostname ?? null },
      notify: this.notify.configured(), instruments: rows, open_alerts: open,
    };
  }

  log(q: { method_id?: string; direction?: string; kind?: string; errors?: boolean; search?: string; limit?: number }) {
    let query = this.db.selectFrom('lab_instrument_messages as g').innerJoin('lab_instruments as i', 'i.id', 'g.instrument_id').innerJoin('lab_methods as m', 'm.id', 'i.method_id')
      .select(['g.id', 'g.direction', 'g.kind', 'g.summary', 'g.raw', 'g.error', 'g.created_at', 'm.name as instrument', 'm.id as method_id'])
      .orderBy('g.id', 'desc').limit(Math.min(Math.max(q.limit ?? 200, 1), 500));
    if (q.method_id) query = query.where('i.method_id', '=', q.method_id);
    if (q.direction === 'in' || q.direction === 'out') query = query.where('g.direction', '=', q.direction);
    if (q.kind) query = query.where('g.kind', '=', q.kind);
    if (q.errors) query = query.where('g.error', 'is not', null);
    if (q.search?.trim()) query = query.where((eb) => eb.or([eb('g.raw', 'ilike', `%${q.search!.trim()}%`), eb('g.summary', 'ilike', `%${q.search!.trim()}%`)]));
    return query.execute();
  }

  async command(dto: CommandDto, user: AuthUser, ctx: AuditContext) {
    let instrumentId: string | null = null;
    if (dto.method_id) {
      const i = await this.instrumentOf(dto.method_id);
      if (!i) throw new BadRequestException('ამ ანალიზატორს კავშირი ჯერ არ აქვს შენახული');
      instrumentId = i.id;
    } else if (!dto.host?.trim() || !dto.port) throw new BadRequestException('მიუთითეთ ანალიზატორი, ან მისამართი და პორტი');
    if (dto.kind !== 'tcp_test' && !instrumentId) throw new BadRequestException('ეს ბრძანება მხოლოდ შენახულ ანალიზატორზე');
    const r = await this.db.insertInto('lab_gateway_commands').values({ instrument_id: instrumentId, kind: dto.kind, requested_by: user.id,
      params: JSON.stringify({ host: dto.host?.trim(), port: dto.port, protocol: dto.protocol }) }).returning('id').executeTakeFirstOrThrow();
    if (dto.kind === 'reconnect') await this.audit.log(ctx, { action: 'LAB_GATEWAY_RECONNECT', entityName: 'lab_instruments', entityId: instrumentId! });
    return { id: String(r.id) };
  }
  async commandResult(id: string) {
    const r = await this.db.selectFrom('lab_gateway_commands').select(['id', 'kind', 'status', 'result', 'created_at', 'finished_at']).where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('ბრძანება ვერ მოიძებნა');
    return r;
  }

  async seenCodes(methodId: string) {
    const i = await this.instrumentOf(methodId);
    if (!i) return [];
    return this.db.selectFrom('lab_instrument_seen_codes as s')
      .leftJoin('lab_instrument_codes as c', (j) => j.onRef('c.instrument_id', '=', 's.instrument_id').on(sql`upper(c.code)`, '=', sql`upper(s.code)`))
      .leftJoin('lab_analytes as a', 'a.id', 'c.analyte_id')
      .select(['s.code', 's.last_value', 's.last_unit', 's.seen_count', 's.first_seen', 's.last_seen', 'c.id as mapping_id', 'a.name as analyte_name'])
      .where('s.instrument_id', '=', i.id).orderBy(sql`c.id is null`, 'desc').orderBy('s.code').execute();
  }

  async options(methodId: string, dto: OptionsDto, ctx: AuditContext) {
    const i = await this.instrumentOf(methodId);
    if (!i) throw new BadRequestException('ჯერ შეინახეთ კავშირის პარამეტრები');
    const set = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) return i;
    await this.db.updateTable('lab_instruments').set(set).where('id', '=', i.id).execute();
    await this.audit.log(ctx, { action: 'UPDATE_LAB_INSTRUMENT_OPTIONS', entityName: 'lab_instruments', entityId: i.id,
      oldData: { listen_only: i.listen_only, alerts_enabled: i.alerts_enabled, silent_minutes: i.silent_minutes }, newData: set });
    return this.instrumentOf(methodId);
  }

  alertSettings() { return this.alerts.settings(); }
  async saveAlertSettings(dto: AlertSettingsDto, ctx: AuditContext) {
    const old = await this.alerts.settings();
    const vals = { ...dto, work_days: [...new Set(dto.work_days)].sort(), sms_phones: dto.sms_phones.map((p) => p.trim()), emails: dto.emails.map((e) => e.trim().toLowerCase()), updated_at: sql<Date>`now()` };
    await this.db.updateTable('lab_gateway_alert_settings').set(vals).where('id', '=', 1).execute();
    await this.audit.log(ctx, { action: 'UPDATE_LAB_ALERT_SETTINGS', entityName: 'lab_gateway_alert_settings', entityId: '1', oldData: old, newData: dto });
    return this.alerts.settings();
  }
  alertHistory(limit = 100) {
    return this.db.selectFrom('lab_gateway_alerts as a').leftJoin('lab_instruments as i', 'i.id', 'a.instrument_id').leftJoin('lab_methods as m', 'm.id', 'i.method_id')
      .select(['a.id', 'a.kind', 'a.message', 'a.started_at', 'a.resolved_at', 'a.notified', 'a.notified_resolved', 'm.name'])
      .orderBy('a.started_at', 'desc').limit(Math.min(limit, 500)).execute();
  }
  testNotify() { return this.alerts.test(); }
}

@Controller('lab/gateway')
@Roles('admin')
export class LabGatewayAdminController {
  constructor(private readonly svc: LabGatewayAdminService) {}

  @Get('dashboard') dashboard() { return this.svc.dashboard(); }
  @Get('log') log(@Query('method_id') m?: string, @Query('direction') d?: string, @Query('kind') k?: string, @Query('errors') e?: string, @Query('search') s?: string, @Query('limit') l?: string) {
    return this.svc.log({ method_id: m, direction: d, kind: k, errors: e === 'true', search: s, limit: Number(l) || 200 });
  }
  @Post('commands') @HttpCode(200)
  command(@Body() dto: CommandDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.svc.command(dto, u, auditCtx(req)); }
  @Get('commands/:id') commandResult(@Param('id') id: string) { return this.svc.commandResult(String(Number(id) || 0)); }
  @Patch('instruments/:methodId/options')
  options(@Param('methodId', ParseUUIDPipe) id: string, @Body() dto: OptionsDto, @Req() req: Request) { return this.svc.options(id, dto, auditCtx(req)); }
  @Get('alert-settings') alertSettings() { return this.svc.alertSettings(); }
  @Put('alert-settings') saveAlertSettings(@Body() dto: AlertSettingsDto, @Req() req: Request) { return this.svc.saveAlertSettings(dto, auditCtx(req)); }
  @Get('alerts') alerts(@Query('limit') l?: string) { return this.svc.alertHistory(Number(l) || 100); }
  @Post('alerts/test') @HttpCode(200) test() { return this.svc.testNotify(); }
}
