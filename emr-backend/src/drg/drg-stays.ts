import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { drgPayers, drgPrices, evaluateStay, mirrorGroup, type StayEval, type StayPrice } from './drg-calc';
import { DRG_ADMIN, DRG_CONFIRM, DRG_STAY_READ, defaultSchemeId, drgRules, stayInfo } from './drg-data';
import { DISCHARGE_KA, SOURCE_KA } from './drg-engine';

const TZ = loadEnv().CLINIC_TZ;

export class DrgConfirmDto {
  @IsUUID() scheme_id: string;
  /** ცარიელი — შეთავაზება; სხვა კოდი — შეცვლა (მიზეზით) */
  @IsOptional() @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/) code?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class DrgResetDto { @IsUUID() scheme_id: string; @IsString() @Length(5, 500) reason: string }

/**
 * DRG შემთხვევაზე (0055): ბილინგის ჩანართის ბლოკი — შეთავაზება („რატომ“), დადასტურება / შეცვლა მიზეზით, გაუქმება.
 *   დადასტურებისას: stay_drg (შემავალი მონაცემების ასლი + ჰეში) → სქემის DRG გადამხდელებს — კოდი და ვერსიის წონა.
 *   ფინალიზებულ ინვოისზე — არა (ჯერ გახსნა).
 */
@Injectable()
export class DrgStaysService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  /** საწოლდღეები ახალი (ხანგრძლივობისთვის) — როგორც ბილინგის ჩანართზე */
  private async syncBedDays(eid: string) {
    const inv = await this.db.selectFrom('invoices').select('finalized_at').where('encounter_id', '=', eid).executeTakeFirst();
    const st = await this.db.selectFrom('inpatient_stays').select('status').where('encounter_id', '=', eid).executeTakeFirst();
    if (!inv || inv.finalized_at || !st || st.status === 'cancelled') return;
    const m = await this.db.selectFrom('system_modules').select('settings').where('code', '=', 'inpatient').executeTakeFirst();
    const leave = (m?.settings as Record<string, unknown> | undefined)?.leave_counts_bed_day !== false;
    await this.db.transaction().execute((trx) => sql`SELECT ipd_sync_bed_days(${eid}::uuid, ${TZ}, ${leave})`.execute(trx));
  }

  private present(ev: StayEval) {
    const r = ev.result;
    return {
      scheme: ev.scheme, version: ev.version, version_date: ev.version_date, hash: ev.hash, stale: ev.stale, stale_reason: ev.stale_reason,
      current: ev.current,
      result: r && { code: r.code, title: r.title, weight: r.weight, rule_seq: r.rule_seq, rule_label: r.rule_label, fallback: r.fallback, cc_level: r.cc_level, issues: r.issues, trace: r.trace },
      inputs: ev.inputs && ev.details && {
        ...ev.inputs, discharge_ka: ev.inputs.discharge ? DISCHARGE_KA[ev.inputs.discharge] ?? ev.inputs.discharge : null, source_ka: ev.inputs.source ? SOURCE_KA[ev.inputs.source] ?? ev.inputs.source : null,
        dx: ev.details.dx, proc_list: ev.details.procs, service_list: ev.details.services, los_bed_days: ev.details.los_bed_days, los_calendar: ev.details.los_calendar,
        age_basis_date: ev.details.age_basis_date,
      },
    };
  }

  /** ბილინგის ჩანართი: DRG გადამხდელების სქემები (ან ნაგულისხმევი — ინფორმაციულად); version_id — მონახაზის შემოწმება (drg_admin) */
  async view(eid: string, u: AuthUser, schemeId?: string, versionId?: string) {
    const st = await stayInfo(this.db, eid);
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    if (versionId && !has(u, ...DRG_ADMIN)) throw new ForbiddenException('მონახაზის შემოწმება — DRG კონფიგურაციის უფლება');
    const rules = await drgRules(this.db);
    await this.syncBedDays(eid);
    const payers = await drgPayers(this.db, eid);
    const inv = await this.db.selectFrom('invoices').select('finalized_at').where('encounter_id', '=', eid).executeTakeFirst();
    let ids = [...new Set(payers.map((p) => p.scheme_id).filter((x): x is string => !!x))];
    const noPayer = ids.length === 0;
    if (schemeId) ids = [schemeId];
    else if (noPayer) { const d = await defaultSchemeId(this.db); ids = d ? [d] : []; }
    // 0056: თანხა გადამხდელზე — ფინალიზებულზე დაფიქსირებული, სხვა შემთხვევაში — მიმდინარე ფორმულით
    const money = has(u, 'admin', 'billing', 'drg', 'drg_admin', 'receptionist', 'manager', 'accountant', 'viewer');
    const prices = new Map<string, StayPrice>();
    if (money && payers.length) {
      if (inv?.finalized_at) {
        const fx = await this.db.selectFrom('stay_payers').select(['id', 'drg_breakdown']).where('encounter_id', '=', eid).where('drg_breakdown', 'is not', null).execute();
        for (const f of fx) prices.set(f.id, f.drg_breakdown as unknown as StayPrice);
      } else {
        const ch = (await sql<{ s: string }>`SELECT coalesce(sum(l.line_total), 0) AS s FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id
          WHERE i.encounter_id = ${eid}::uuid AND NOT l.package_included`.execute(this.db)).rows[0]?.s;
        for (const [k, v] of await drgPrices(this.db, eid, Number(ch ?? 0), rules)) prices.set(k, v);
      }
    }
    const schemes = [];
    for (const sid of ids) {
      const ev = await evaluateStay(this.db, eid, sid, { rules, st, versionId });
      schemes.push({ ...this.present(ev), payers: payers.filter((p) => p.scheme_id === sid).map(({ drg_scheme_id: _x, ...p }) => ({ ...p, price: prices.get(p.id) ?? null })) });
    }
    return {
      enabled: rules.enabled, settings: { confirm_required: rules.confirm_required, recheck_on_finalize: rules.recheck_on_finalize, manual_payer_drg: rules.manual_payer_drg,
        version_date_basis: rules.version_date_basis },
      stay: { adm_no: st.adm_no, status: st.status }, finalized: !!inv?.finalized_at, no_drg_payer: noPayer, test_version: !!versionId,
      can: { confirm: has(u, ...DRG_CONFIRM) && !inv?.finalized_at && st.status !== 'cancelled', admin: has(u, ...DRG_ADMIN), money },
      schemes,
    };
  }

  async confirm(eid: string, dto: DrgConfirmDto, u: AuthUser, ctx: AuditContext) {
    const rules = await drgRules(this.db);
    if (!rules.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „DRG“ გამორთულია (ადმინისტრირება → მოდულები)' });
    await this.syncBedDays(eid);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const inv = await trx.selectFrom('invoices').select(['id', 'finalized_at']).where('encounter_id', '=', eid).forUpdate().executeTakeFirst();
        if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
        if (inv.finalized_at) throw new ConflictException({ code: 'FINALIZED', message: 'ინვოისი ფინალიზებულია — ცვლილებისთვის საჭიროა გახსნა (ბილინგი)' });
        const st = await stayInfo(trx, eid);
        if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
        if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
        const ev = await evaluateStay(trx, eid, dto.scheme_id, { rules, st });
        if (!ev.version || !ev.inputs || !ev.result) throw new ConflictException({ code: 'DRG_NO_VERSION', message: `სქემას (${ev.scheme.name}) ${ev.version_date}-ზე მოქმედი ვერსია არ აქვს` });
        const code = (dto.code ?? '').trim().toUpperCase() || ev.result.code;
        if (!code) throw new BadRequestException(`ჯგუფი ვერ განისაზღვრა: ${ev.result.issues.map((i) => i.message).join('; ') || '—'} — აირჩიეთ ჯგუფი ხელით (მიზეზით)`);
        const overridden = code !== ev.result.code;
        const reason = dto.reason?.trim() || null;
        if (overridden && (reason?.length ?? 0) < 5) throw new BadRequestException('შეთავაზებისგან განსხვავებულ ჯგუფს სჭირდება მიზეზი (მინ. 5 სიმბოლო)');
        const g = await trx.selectFrom('drg_version_groups').select(['code', 'title', 'weight']).where('version_id', '=', ev.version.id).where('code', '=', code).executeTakeFirst();
        if (!g) throw new BadRequestException(`ჯგუფი ${code} ვერსიაში (${ev.version.label}) არ არის`);
        const old = ev.current;
        if (old) await trx.updateTable('stay_drg').set({ superseded_at: sql`now()`, superseded_by: u.id, supersede_reason: 'ხელახლა დადასტურება' }).where('id', '=', old.id).execute();
        const r = ev.result;
        const trace = { cc_level: r.cc_level, rule: r.rule_seq ? { seq: r.rule_seq, label: r.rule_label, conds: r.trace.matched?.conds ?? [] } : null, cc: r.trace.cc, issues: r.issues,
          fallback: r.fallback, details: ev.details };
        const row = await trx.insertInto('stay_drg').values({
          encounter_id: eid, scheme_id: dto.scheme_id, version_id: ev.version.id, inputs: JSON.stringify(ev.inputs), inputs_hash: ev.hash!, suggested_code: r.code, suggested_rule_id: r.rule_id,
          trace: JSON.stringify(trace), status: overridden ? 'overridden' : 'confirmed', final_code: code, final_weight: String(g.weight), reason, confirmed_by: u.id,
        }).returningAll().executeTakeFirstOrThrow();
        await mirrorGroup(trx, g);
        // სქემის DRG გადამხდელები — კოდი და წონა (განაკვეთი — მინიჭებისას დაფიქსირებული)
        const payers = (await drgPayers(trx, eid)).filter((p) => p.scheme_id === dto.scheme_id);
        for (const p of payers) {
          await trx.updateTable('stay_payers').set({ drg_code: code, drg_weight: String(g.weight), drg_source: 'grouper', drg_version_id: ev.version.id, stay_drg_id: row.id })
            .where('id', '=', p.id).execute();
        }
        await trx.insertInto('inpatient_events').values({ encounter_id: eid, kind: 'drg_confirmed', user_id: u.id,
          data: JSON.stringify({ scheme: ev.scheme.code, version: ev.version.label, code, weight: g.weight, suggested: r.code, overridden, reason, previous: old?.final_code ?? null }) }).execute();
        await this.audit.log(ctx, { action: overridden ? 'DRG_OVERRIDE' : 'DRG_CONFIRM', entityName: 'stay_drg', entityId: row.id,
          oldData: old ? { code: old.final_code, status: old.status } : undefined, newData: { encounter_id: eid, code, weight: g.weight, suggested: r.code, reason, payers: payers.length } }, trx);
        return { id: row.id, status: row.status, code, title: g.title, weight: g.weight, payers_updated: payers.length };
      });
    } catch (e) { mapPgError(e, { chk_stay_drg_override: 'შეცვლას სჭირდება მიზეზი (მინ. 5 სიმბოლო)' }); }
  }

  async reset(eid: string, dto: DrgResetDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const inv = await trx.selectFrom('invoices').select(['finalized_at']).where('encounter_id', '=', eid).forUpdate().executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      if (inv.finalized_at) throw new ConflictException({ code: 'FINALIZED', message: 'ინვოისი ფინალიზებულია — ცვლილებისთვის საჭიროა გახსნა (ბილინგი)' });
      const cur = await trx.selectFrom('stay_drg').select(['id', 'final_code']).where('encounter_id', '=', eid).where('scheme_id', '=', dto.scheme_id).where('superseded_at', 'is', null)
        .forUpdate().executeTakeFirst();
      if (!cur) throw new ConflictException('დადასტურებული DRG არ არის');
      await trx.updateTable('stay_drg').set({ superseded_at: sql`now()`, superseded_by: u.id, supersede_reason: dto.reason.trim() }).where('id', '=', cur.id).execute();
      await trx.updateTable('stay_payers').set({ stay_drg_id: null }).where('stay_drg_id', '=', cur.id).execute();
      await trx.insertInto('inpatient_events').values({ encounter_id: eid, kind: 'drg_reset', user_id: u.id, data: JSON.stringify({ code: cur.final_code, reason: dto.reason.trim() }) }).execute();
      await this.audit.log(ctx, { action: 'DRG_RESET', entityName: 'stay_drg', entityId: cur.id, oldData: { code: cur.final_code }, newData: { reason: dto.reason } }, trx);
      return { ok: true };
    });
  }

  /** ისტორია: ყველა დადასტურება (მათ შორის ჩანაცვლებული) */
  async history(eid: string) {
    const rows = await this.db.selectFrom('stay_drg as d').innerJoin('users as u', 'u.id', 'd.confirmed_by').innerJoin('drg_versions as v', 'v.id', 'd.version_id')
      .innerJoin('drg_schemes as s', 's.id', 'd.scheme_id').leftJoin('users as x', 'x.id', 'd.superseded_by')
      .select(['d.id', 's.code as scheme_code', 'v.label as version_label', 'd.status', 'd.final_code', 'd.final_weight', 'd.suggested_code', 'd.reason', 'd.confirmed_at', 'd.superseded_at',
        'd.supersede_reason', 'd.trace', sql<string>`u.first_name || ' ' || u.last_name`.as('confirmed_by_name'), sql<string | null>`x.first_name || ' ' || x.last_name`.as('superseded_by_name')])
      .where('d.encounter_id', '=', eid).orderBy('d.confirmed_at', 'desc').execute();
    return rows.map((r) => ({ ...r, rule_text: ((r.trace as { rule?: { conds?: { text: string }[] } })?.rule?.conds ?? []).map((c) => c.text).join(' & ') || null, trace: undefined }));
  }
}


@Controller('drg')
export class DrgStaysController {
  constructor(private readonly s: DrgStaysService) {}
  @Get('stays/:eid') @Roles(...DRG_STAY_READ)
  view(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Query('scheme_id') sid?: string, @Query('version_id') vid?: string) {
    const uuid = /^[0-9a-f-]{36}$/i;
    if ((sid && !uuid.test(sid)) || (vid && !uuid.test(vid))) throw new BadRequestException('scheme_id / version_id');
    if (vid && !sid) throw new BadRequestException('version_id-ს სჭირდება scheme_id');
    return this.s.view(eid, u, sid || undefined, vid || undefined);
  }
  @Get('stays/:eid/history') @Roles(...DRG_STAY_READ) history(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.history(eid); }
  @Post('stays/:eid/confirm') @HttpCode(200) @Roles(...DRG_CONFIRM)
  confirm(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: DrgConfirmDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirm(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/reset') @HttpCode(200) @Roles(...DRG_CONFIRM)
  reset(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: DrgResetDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reset(eid, d, u, auditCtx(r)); }
}
