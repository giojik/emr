import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { countCache } from '../worklist/worklist-tasks';
import { RequireModule } from '../modules/module-guard';

/**
 * 0084 — პასუხის გაცნობა (ექიმი): „გავეცანი“ ვალიდირებულ / ხელმოწერილ პასუხზე (ლაბ., რადიოლოგია, ენდოსკოპია).
 *  • კრიტიკული (ლაბ. HH / LL, რადიოლოგიის კრიტიკული მიგნება) — ქმედება სავალდებულოა (დაკვირვება / მკურნალობა / განმეორებითი კვლევა / ესკალაცია / სხვა — შენიშვნით).
 *  • ვინ: ექიმი — დამნიშნავი, მკურნალი ან ვიზიტის / საწოლის განყოფილების ექიმი. ერთი ექიმის გაცნობა პასუხს ყველასთვის ხურავს.
 *  • ჟურნალი უცვლელია (dx_result_acks — INSERT / SELECT); შესწორებული (ხელახლა ვალიდირებული) პასუხი თავიდან საჭიროებს გაცნობას.
 */
const ACTIONS = ['monitor', 'treatment', 'repeat', 'escalated', 'other'] as const;
type Action = (typeof ACTIONS)[number];
export const ACK_ACTION_KA: Record<Action, string> = { monitor: 'დაკვირვება', treatment: 'მკურნალობა შეიცვალა', repeat: 'განმეორებითი კვლევა', escalated: 'ესკალაცია', other: 'სხვა' };

const CUR_DEP = sql<string | null>`coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = e.id AND a.end_kind IS DISTINCT FROM 'cancel'
  ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT 1), e.department_id)`;
const CRIT = sql<boolean>`((i.section = 'lab' AND EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.flag IN ('HH', 'LL')))
  OR (i.section <> 'lab' AND EXISTS (SELECT 1 FROM dx_reports rr WHERE rr.order_item_id = i.id AND rr.is_critical AND rr.status = 'signed')))`;

@Injectable()
export class DxAcksService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  /** ვიზიტთან კავშირი: დამნიშნავი (ნებისმიერი შეკვეთის), მკურნალი, ვიზიტის / მიმდინარე საწოლის განყოფილების ექიმი */
  private async related(u: AuthUser, encounterId: string) {
    if (!has(u, 'doctor')) return false;
    const r = (await sql<{ ok: boolean }>`SELECT (e.attending_doctor_id = ${u.id}
        OR EXISTS (SELECT 1 FROM dx_order_items i WHERE i.encounter_id = e.id AND i.ordered_by = ${u.id})
        OR EXISTS (SELECT 1 FROM users me WHERE me.id = ${u.id} AND me.department_id IS NOT NULL AND me.department_id IN (e.department_id, ${CUR_DEP}))) AS ok
      FROM encounters e WHERE e.id = ${encounterId}`.execute(this.db)).rows[0];
    return !!r?.ok;
  }

  /** ვიზიტის ვალიდირებული პასუხები (ბოლო ack_days), გაცნობის სტატუსით */
  async pending(encounterId: string, u: AuthUser) {
    const e = await this.db.selectFrom('encounters as e').innerJoin('patients as p', 'p.id', 'e.patient_id')
      .select(['e.id', 'e.type', 'e.status', 'e.patient_id', sql<string>`p.last_name || ' ' || p.first_name`.as('patient_name'), 'p.personal_number', 'p.birth_date'])
      .where('e.id', '=', encounterId).executeTakeFirst();
    if (!e) throw new NotFoundException('ვიზიტი ვერ მოიძებნა');
    if (!(await this.related(u, encounterId)) && !has(u, 'admin')) throw new ForbiddenException('გაცნობა — დამნიშნავი / მკურნალი / განყოფილების ექიმი');
    const days = await this.ackDays();
    const items = (await sql<{ id: string; section: string; name: string; validated_at: Date; critical: boolean; ordered_by_name: string | null; validated_by_name: string | null;
      results: { name: string; value: string | null; unit: string; flag: string | null }[] | null; impression: string | null; performed_by: string; is_micro: boolean;
      acked_at: Date | null; acked_by_name: string | null; ack_action: string | null; ack_note: string | null; ack_kind: string | null }>`
      SELECT i.id, i.section, sv.name, i.validated_at, ${CRIT} AS critical, sv.performed_by, sv.is_micro,
             ob.last_name || ' ' || ob.first_name AS ordered_by_name, vb.last_name || ' ' || vb.first_name AS validated_by_name,
             (SELECT json_agg(json_build_object('name', a.name, 'value', coalesce(r.value_num::text, r.value_text), 'unit', r.unit, 'flag', r.flag) ORDER BY a.sort_order)
                FROM lab_results r JOIN lab_analytes a ON a.id = r.analyte_id WHERE r.order_item_id = i.id) AS results,
             (SELECT rr.impression FROM dx_reports rr WHERE rr.order_item_id = i.id) AS impression,
             k.acked_at, k.by AS acked_by_name, k.action AS ack_action, k.note AS ack_note, k.kind AS ack_kind
        FROM dx_order_items i JOIN dx_services sv ON sv.id = i.service_id JOIN encounters e ON e.id = i.encounter_id
        LEFT JOIN users ob ON ob.id = i.ordered_by LEFT JOIN users vb ON vb.id = i.validated_by
        LEFT JOIN LATERAL (SELECT a.acked_at, a.action, a.note, a.kind, au.last_name || ' ' || au.first_name AS by FROM dx_result_acks a JOIN users au ON au.id = a.acked_by
                             WHERE a.order_item_id = i.id AND a.acked_at >= i.validated_at ORDER BY (a.kind = 'critical') DESC, a.acked_at LIMIT 1) k ON TRUE
       WHERE i.encounter_id = ${encounterId} AND i.status = 'validated' AND i.validated_at > now() - make_interval(days => ${days}::int)
       ORDER BY (k.acked_at IS NULL) DESC, ${CRIT} DESC, i.validated_at DESC LIMIT 200`.execute(this.db)).rows;
    return {
      encounter: { id: e.id, type: e.type, status: e.status, patient_id: e.patient_id, patient_name: e.patient_name, personal_number: e.personal_number, birth_date: e.birth_date },
      can_ack: await this.related(u, encounterId),
      items: items.map((x) => ({ ...x, abnormal: x.section !== 'lab' || x.performed_by === 'external' || x.is_micro || (x.results ?? []).some((r) => !!r.flag && r.flag !== 'N'),
        // critical ack: მხოლოდ critical ტიპის ჩანაწერი ხურავს კრიტიკულს
        acked: !!x.acked_at && (!x.critical || x.ack_kind === 'critical') })),
      actions: ACK_ACTION_KA,
    };
  }

  private async ackDays() {
    const m = await this.db.selectFrom('system_modules').select('settings').where('code', '=', 'worklist').executeTakeFirst();
    return Number((m?.settings as { ack_days?: number } | undefined)?.ack_days ?? 30);
  }

  /** „გავეცანი“: რამდენიმე პასუხი ერთად; კრიტიკულზე — ქმედება */
  async ack(d: { item_ids: string[]; action?: Action; note?: string }, u: AuthUser, req: Request) {
    if (!has(u, 'doctor')) throw new ForbiddenException('გაცნობა — მხოლოდ ექიმი');
    if (d.action === 'other' && (d.note?.trim().length ?? 0) < 3) throw new BadRequestException('„სხვა“ — მიუთითეთ შენიშვნა (მინ. 3 სიმბოლო)');
    const ids = [...new Set(d.item_ids)];
    const rows = (await sql<{ id: string; encounter_id: string; patient_id: string; status: string; validated_at: Date | null; critical: boolean; done: boolean }>`
      SELECT i.id, i.encounter_id, i.patient_id, i.status, i.validated_at, ${CRIT} AS critical,
             EXISTS (SELECT 1 FROM dx_result_acks a WHERE a.order_item_id = i.id AND a.acked_at >= i.validated_at AND (a.kind = 'critical' OR NOT ${CRIT})) AS done
        FROM dx_order_items i WHERE i.id = ANY (${ids}::uuid[])`.execute(this.db)).rows;
    if (rows.length !== ids.length) throw new NotFoundException('პასუხი ვერ მოიძებნა');
    if (rows.some((r) => r.status !== 'validated')) throw new BadRequestException('გაცნობა — მხოლოდ ვალიდირებულ / ხელმოწერილ პასუხზე');
    for (const enc of new Set(rows.map((r) => r.encounter_id))) if (!(await this.related(u, enc))) throw new ForbiddenException('გაცნობა — დამნიშნავი / მკურნალი / განყოფილების ექიმი');
    if (rows.some((r) => r.critical && !r.done) && !d.action)
      throw new BadRequestException({ code: 'CRITICAL_ACTION_REQUIRED', message: 'კრიტიკული პასუხი: მიუთითეთ ქმედება (დაკვირვება / მკურნალობა / განმეორებითი კვლევა / ესკალაცია / სხვა)' });
    const todo = rows.filter((r) => !r.done);
    const ctx = auditCtx(req);
    await this.db.transaction().execute(async (trx) => {
      for (const r of todo) {
        await trx.insertInto('dx_result_acks').values({ order_item_id: r.id, patient_id: r.patient_id, kind: r.critical ? 'critical' : 'ack',
          action: d.action ?? null, note: d.note?.trim() || null, acked_by: u.id }).execute();
      }
      if (todo.length) await this.audit.log(ctx, { action: 'DX_RESULT_ACK', entityName: 'dx_order_items', entityId: todo[0].id,
        newData: { items: todo.map((r) => r.id), critical: todo.filter((r) => r.critical).map((r) => r.id), action: d.action ?? null, note: d.note ?? null } }, trx);
    });
    countCache.clear();
    return { acked: todo.length, already: rows.length - todo.length };
  }

  /** ერთი შეკვეთის გაცნობის ისტორია */
  history(itemId: string) {
    return this.db.selectFrom('dx_result_acks as a').innerJoin('users as u', 'u.id', 'a.acked_by')
      .select(['a.id', 'a.kind', 'a.action', 'a.note', 'a.acked_at', sql<string>`u.last_name || ' ' || u.first_name`.as('acked_by_name')])
      .where('a.order_item_id', '=', itemId).orderBy('a.acked_at', 'desc').execute();
  }
}

class AckDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) item_ids: string[];
  @IsOptional() @IsIn(ACTIONS) action?: Action;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

@Controller('dx')
@RequireModule('lab', 'radiology', 'endoscopy')
export class DxAcksController {
  constructor(private readonly s: DxAcksService) {}
  @Get('acks/pending') @Roles('admin', 'doctor')
  pending(@Query('encounter_id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.pending(id, u); }
  @Post('acks') @HttpCode(200) @Roles('doctor')
  ack(@Body() d: AckDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.ack(d, u, r); }
  @Get('acks/item/:id') @Roles('admin', 'doctor', 'nurse', 'lab_doctor', 'radiologist', 'endoscopist')
  history(@Param('id', ParseUUIDPipe) id: string) { return this.s.history(id); }
}
