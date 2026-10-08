import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Post, Query, Req } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { mapPgError } from '../common/pg-errors';
import { InpatientModule, InpatientService } from './inpatient';

export class TransferRequestDto {
  @IsUUID() to_department_id: string;
  @IsString() @Length(3, 1000) reason: string;
}
export class TransferAcceptDto {
  @IsUUID() attending_doctor_id: string;
  @IsOptional() @IsUUID() bed_id?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
}
export class TransferReasonDto { @IsString() @Length(3, 1000) reason: string }

/**
 * გადაყვანა განყოფილებებს შორის (0041) — მიმღების დადასტურებით.
 *   მოთხოვნა: გამგზავნი განყოფილების თანამშრომელი ან მკურნალი ექიმი (ერთ ჰოსპიტალიზაციაზე — ერთი ღია).
 *   მოთხოვნის დროს პაციენტი ძველ საწოლზეა (ეპიზოდი ღიაა). მიღება — მიმღები განყოფილების თანამშრომელი:
 *     ახალი მკურნალი ექიმი (სავალდებულო) + საწოლი (ან მის გარეშე — მიმღების დაფაზე „ელოდება საწოლს“);
 *     ძველი ეპიზოდი იხურება (end_kind = transfer), ძველი საწოლი → დასალაგებელი / თავისუფალი; encounters.department_id → ახალი.
 *   უარყოფა — მიმღები (მიზეზით); გაუქმება — გამგზავნი მხარე (მიზეზით).
 *   ვადაგადაცილება (transfer_wait_hours) — worker-ი ატყობინებს ორივე განყოფილებას (inpatient-reminders).
 */
@Injectable()
export class TransfersService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService) {}

  private base() {
    return this.db.selectFrom('inpatient_transfers as t').innerJoin('inpatient_stays as st', 'st.encounter_id', 't.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('departments as fd', 'fd.id', 't.from_department_id').innerJoin('departments as td', 'td.id', 't.to_department_id')
      .leftJoin('bed_assignments as fa', 'fa.id', 't.from_assignment_id').leftJoin('beds as fb', 'fb.id', 'fa.bed_id')
      .leftJoin('users as rq', 'rq.id', 't.requested_by').leftJoin('users as dc', 'dc.id', 't.decided_by')
      .select(['t.id', 't.encounter_id', 't.status', 't.reason', 't.requested_at', 't.decided_at', 't.decision_reason', 't.from_department_id', 't.to_department_id',
        'fd.name as from_department', 'td.name as to_department', 'fb.code as from_bed', 'st.adm_no', 'st.severity', 'st.isolation', 'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.gender', 'p.birth_date',
        sql<string>`rq.last_name || ' ' || rq.first_name`.as('requested_by_name'), sql<string | null>`dc.last_name || ' ' || dc.first_name`.as('decided_by_name'),
        sql<number>`(extract(epoch FROM (coalesce(t.decided_at, now()) - t.requested_at)) / 60)::int`.as('waiting_min')]);
  }

  async list(q: { departmentId?: string; direction?: 'in' | 'out'; status?: string; encounterId?: string }) {
    let query = this.base().orderBy('t.requested_at', 'desc').limit(200);
    if (q.encounterId) query = query.where('t.encounter_id', '=', q.encounterId);
    if (q.departmentId) query = query.where(q.direction === 'out' ? 't.from_department_id' : 't.to_department_id', '=', q.departmentId);
    if (q.status) query = query.where('t.status', '=', q.status);
    return query.execute();
  }

  /** opts.authorized — უფლება უკვე შემოწმებულია გამომძახებელ მოდულში (0050: PACU-დან გამოწერა — საოპერაციო ექთანი / ანესთეზიოლოგი) */
  async request(encounterId: string, dto: TransferRequestDto, u: AuthUser, ctx: AuditContext, opts: { authorized?: boolean; source?: string } = {}) {
    try {
      const out = await this.db.transaction().execute(async (trx) => {
        const st = await this.ipd.lockStay(trx, encounterId);
        const cur = await trx.selectFrom('bed_assignments').selectAll().where('encounter_id', '=', encounterId).where('ended_at', 'is', null).forUpdate().executeTakeFirstOrThrow();
        const e = await trx.selectFrom('encounters').select(['attending_doctor_id']).where('id', '=', encounterId).executeTakeFirstOrThrow();
        if (!opts.authorized && !(await this.ipd.isStaff(u, cur.department_id, trx)) && e.attending_doctor_id !== u.id) {
          throw new ForbiddenException('გადაყვანას ითხოვს განყოფილების თანამშრომელი ან მკურნალი ექიმი');
        }
        const leave = await trx.selectFrom('inpatient_leaves').select('id').where('encounter_id', '=', encounterId).where('returned_at', 'is', null).executeTakeFirst();
        if (leave) throw new ConflictException('პაციენტი დროებით გასულია — გადაყვანა დაბრუნების შემდეგ');
        if (dto.to_department_id === cur.department_id) throw new BadRequestException('პაციენტი უკვე ამ განყოფილებაშია (საწოლის შეცვლა — „საწოლის შეცვლით“)');
        const to = await this.ipd.department(dto.to_department_id, trx);
        const from = await trx.selectFrom('departments').select('name').where('id', '=', cur.department_id).executeTakeFirstOrThrow();
        const t = await trx.insertInto('inpatient_transfers').values({ encounter_id: encounterId, from_assignment_id: cur.id, from_department_id: cur.department_id,
          to_department_id: to.id, reason: dto.reason.trim(), requested_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await this.ipd.event(trx, { encounter_id: encounterId, kind: 'transfer_requested', data: { transfer_id: t.id, from: from.name, to: to.name, reason: dto.reason.trim(),
          ...(opts.source && { source: opts.source }) } }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_TRANSFER_REQUEST', entityName: 'inpatient_transfers', entityId: t.id, newData: { encounter_id: encounterId, ...dto } }, trx);
        const p = await trx.selectFrom('patients').select(['first_name', 'last_name']).where('id', '=', st.patient_id).executeTakeFirstOrThrow();
        return { id: t.id, to, from: from.name, patient: `${p.last_name} ${p.first_name}`, adm_no: st.adm_no };
      });
      await this.ipd.notifyDepartment(out.to.id, ['nurse', 'doctor', 'manager'], { kind: 'inpatient_transfer', title: `${out.to.name}: გადმოყვანის მოთხოვნა`,
        body: `${out.patient} (${out.adm_no}) — ${out.from}`, item: out.adm_no, entityId: out.to.id, link: `/inpatient?tab=board&department_id=${out.to.id}` });
      return this.get(out.id);
    } catch (e) { mapPgError(e, { ux_inpatient_transfers_open: 'ამ პაციენტზე გადაყვანის მოთხოვნა უკვე გაგზავნილია' }); }
  }

  async get(id: string) {
    const t = await this.base().where('t.id', '=', id).executeTakeFirst();
    if (!t) throw new NotFoundException('გადაყვანის მოთხოვნა ვერ მოიძებნა');
    return t;
  }

  async accept(id: string, dto: TransferAcceptDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    try {
      await this.db.transaction().execute(async (trx) => {
        const t = await trx.selectFrom('inpatient_transfers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!t) throw new NotFoundException('გადაყვანის მოთხოვნა ვერ მოიძებნა');
        if (t.status !== 'requested') throw new ConflictException('მოთხოვნა უკვე დამუშავებულია');
        if (!(await this.ipd.isStaff(u, t.to_department_id, trx))) throw new ForbiddenException('გადმოყვანას იღებს მიმღები განყოფილების თანამშრომელი');
        const st = await this.ipd.lockStay(trx, t.encounter_id);
        const cur = await trx.selectFrom('bed_assignments').selectAll().where('encounter_id', '=', t.encounter_id).where('ended_at', 'is', null).forUpdate().executeTakeFirstOrThrow();
        if (cur.id !== t.from_assignment_id) throw new ConflictException('მოთხოვნის შემდეგ პაციენტის საწოლი / განყოფილება შეიცვალა — გააუქმეთ და ხელახლა მოითხოვეთ');
        const doc = await this.ipd.doctor(dto.attending_doctor_id, trx);
        const to = await this.ipd.department(t.to_department_id, trx);
        let bed: Awaited<ReturnType<InpatientService['lockBed']>> | null = null;
        if (dto.bed_id) {
          const gender = (await trx.selectFrom('patients').select('gender').where('id', '=', st.patient_id).executeTakeFirstOrThrow()).gender;
          bed = await this.ipd.lockBed(trx, dto.bed_id, { departmentId: to.id, gender, isolation: st.isolation, confirm: dto.confirm }, s);
        }
        // ძველი ეპიზოდი → დახურვა; ძველი საწოლი → დასალაგებელი / თავისუფალი
        await trx.updateTable('bed_assignments').set({ ended_at: sql`now()`, ended_by: u.id, end_kind: 'transfer' }).where('id', '=', cur.id).execute();
        let oldBed: { id: string; code: string } | undefined;
        if (cur.bed_id) {
          oldBed = await trx.selectFrom('beds').select(['id', 'code']).where('id', '=', cur.bed_id).forUpdate().executeTakeFirstOrThrow();
          await this.ipd.releaseBed(trx, oldBed.id, s, u);
        }
        const na = await trx.insertInto('bed_assignments').values({ encounter_id: t.encounter_id, department_id: to.id, bed_id: bed?.id ?? null, bed_at: bed ? sql`now()` : null,
          bed_by: bed ? u.id : null, reason: t.reason, assigned_by: u.id }).returning('id').executeTakeFirstOrThrow();
        if (bed) await this.ipd.setBed(trx, bed.id, 'occupied', u);
        const prev = await trx.selectFrom('encounters').select('attending_doctor_id').where('id', '=', t.encounter_id).executeTakeFirstOrThrow();
        await trx.updateTable('encounters').set({ department_id: to.id, attending_doctor_id: doc.id }).where('id', '=', t.encounter_id).execute();
        await trx.updateTable('inpatient_transfers').set({ status: 'accepted', decided_by: u.id, decided_at: sql`now()`, to_assignment_id: na.id, new_attending_id: doc.id })
          .where('id', '=', id).execute();
        await this.ipd.event(trx, { encounter_id: t.encounter_id, bed_id: bed?.id ?? null, kind: 'transfer_accepted', data: { transfer_id: id, to: to.name, bed: bed?.code ?? null,
          from_bed: oldBed?.code ?? null, warnings: bed?.warnings ?? [] } }, u);
        if (prev.attending_doctor_id !== doc.id) {
          await this.ipd.event(trx, { encounter_id: t.encounter_id, kind: 'attending_changed', data: { from: prev.attending_doctor_id, to: doc.id, to_name: `${doc.last_name} ${doc.first_name}`, reason: 'გადაყვანა' } }, u);
        }
        if (oldBed) await this.ipd.event(trx, { encounter_id: t.encounter_id, bed_id: oldBed.id, kind: 'bed_released', data: { bed: oldBed.code, to: s.cleaning_required ? 'cleaning' : 'free' } }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_TRANSFER_ACCEPT', entityName: 'inpatient_transfers', entityId: id, newData: { bed_id: dto.bed_id ?? null, attending_doctor_id: doc.id } }, trx);
      });
    } catch (e) { mapPgError(e, { ux_bed_assignments_bed: 'საწოლი უკვე დაკავებულია' }); }
    return this.get(id);
  }

  async decide(id: string, action: 'reject' | 'cancel', reason: string, u: AuthUser, ctx: AuditContext) {
    const out = await this.db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('inpatient_transfers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw new NotFoundException('გადაყვანის მოთხოვნა ვერ მოიძებნა');
      if (t.status !== 'requested') throw new ConflictException('მოთხოვნა უკვე დამუშავებულია');
      if (action === 'reject' && !(await this.ipd.isStaff(u, t.to_department_id, trx))) throw new ForbiddenException('უარყოფს მიმღები განყოფილების თანამშრომელი');
      if (action === 'cancel' && !(t.requested_by === u.id || has(u, 'admin') || await this.ipd.isStaff(u, t.from_department_id, trx))) {
        throw new ForbiddenException('აუქმებს მომთხოვნი ან გამგზავნი განყოფილების თანამშრომელი');
      }
      const status = action === 'reject' ? 'rejected' : 'cancelled';
      await trx.updateTable('inpatient_transfers').set({ status, decided_by: u.id, decided_at: sql`now()`, decision_reason: reason.trim() }).where('id', '=', id).execute();
      await this.ipd.event(trx, { encounter_id: t.encounter_id, kind: action === 'reject' ? 'transfer_rejected' : 'transfer_cancelled', data: { transfer_id: id, reason: reason.trim() } }, u);
      await this.audit.log(ctx, { action: action === 'reject' ? 'INPATIENT_TRANSFER_REJECT' : 'INPATIENT_TRANSFER_CANCEL', entityName: 'inpatient_transfers', entityId: id, newData: { reason } }, trx);
      return t;
    });
    if (action === 'reject') {
      const r = await this.get(id);
      await this.ipd.notifyDepartment(out.from_department_id, ['nurse', 'doctor', 'manager'], { kind: 'ipd_transfer_reject', title: `${r.to_department}: გადაყვანა უარყოფილია`,
        body: `${r.last_name} ${r.first_name} (${r.adm_no}) — ${reason.trim()}`, item: r.adm_no, entityId: out.from_department_id, link: `/inpatient/stay/${out.encounter_id}` });
    }
    return this.get(id);
  }
}

@Controller('inpatient')
export class TransfersController {
  constructor(private readonly s: TransfersService) {}
  @Get('transfers') @Roles('admin', 'doctor', 'nurse', 'manager')
  list(@Query('department_id') departmentId?: string, @Query('direction') direction?: string, @Query('status') status?: string, @Query('encounter_id') encounterId?: string) {
    if (direction && !['in', 'out'].includes(direction)) throw new BadRequestException('direction: in | out');
    if (status && !['requested', 'accepted', 'rejected', 'cancelled'].includes(status)) throw new BadRequestException('status');
    return this.s.list({ departmentId, direction: direction as 'in' | 'out' | undefined, status, encounterId });
  }
  @Post('stays/:eid/transfer') @Roles('admin', 'doctor', 'nurse', 'manager')
  request(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: TransferRequestDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.request(eid, d, u, auditCtx(r)); }
  @Post('transfers/:id/accept') @HttpCode(200) @Roles('admin', 'doctor', 'nurse', 'manager')
  accept(@Param('id', ParseUUIDPipe) id: string, @Body() d: TransferAcceptDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.accept(id, d, u, auditCtx(r)); }
  @Post('transfers/:id/:action') @HttpCode(200) @Roles('admin', 'doctor', 'nurse', 'manager')
  decide(@Param('id', ParseUUIDPipe) id: string, @Param('action') action: string, @Body() d: TransferReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (action !== 'reject' && action !== 'cancel') throw new NotFoundException();
    return this.s.decide(id, action, d.reason, u, auditCtx(r));
  }
}

@Module({ imports: [InpatientModule], providers: [TransfersService], controllers: [TransfersController], exports: [TransfersService] })
export class TransfersModule {}
