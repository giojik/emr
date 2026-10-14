import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { applyOpdRules } from '../tariffs/payer-shares';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { addDays, DATE_RE, type Ex, FinCommon, n, r2, toCsv, type Trx, userName } from './finance-common';
import { CLAIM_RESOLVE, FIN_EDIT, FIN_FULL, PAYER_KIND_KA } from './finance-rules';
import { errorText, loadRules, scrubInvoice, scrubSettings, type ScrubResult } from '../scrub/scrub-engine';

const ERR = {
  fin_claim_item_amounts: 'ანაზღაურებული + გადაწყვეტილი თანხა აღემატება მოთხოვნილს',
  ux_fin_claim_items_case: 'შემთხვევა უკვე შედის სხვა ქლეიმში',
  fin_claim_not_draft: 'ქლეიმი გაგზავნილია — შემადგენლობა აღარ იცვლება',
  fin_claim_not_open: 'ანაზღაურება — მხოლოდ გაგზავნილ, დაუფარავ ქლეიმზე',
  fin_claim_pay_immutable: 'ანაზღაურება უცვლელია — მხოლოდ გაუქმება',
  chk_invoice_overpaid: 'გადახდილი თანხა აღემატება პაციენტის წილს',
};
const pg = (e: unknown): never => mapPgError(e, ERR);
const OUTSTANDING = sql<string>`(ci.claimed - ci.paid - ci.resolved_amount)`;

export interface Candidate {
  kind: 'ipd' | 'opd'; invoice_id: string; stay_payer_id: string | null; payer_id: string; share_slot: 'insurance' | 'state'; claimed: string; case_date: string;
  invoice_number: string; adm_no: string | null; patient: string; personal_number: string | null; policy_no: string | null; guarantee_no: string | null;
}

/**
 * გადამხდელის დებიტორები (0053): ქლეიმი = გადამხდელი × პერიოდი; შემთხვევები — ფინალიზებული სტაციონარი (stay_payers.covered_amount)
 * და ამბულატორიის ინვოისი (insurance_payer_id / state_payer_id). მონახაზი → გაგზავნა (ნომერი, ვადა) → ანაზღაურება (განაწილებით)
 * → დანაკლისის / უარის გადაწყვეტა: პაციენტზე (ინვოისის წილი გადადის პაციენტზე) ან ჩამოწერა (შემოსავალში — „უარი“).
 */
@Injectable()
export class FinClaimsService {
  constructor(private readonly c: FinCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  /** ქლეიმში ჯერ არშემავალი შემთხვევები (გადამხდელი × პერიოდი; ერთი შემთხვევა × გადამხდელი — მხოლოდ ერთ ქლეიმში) */
  async candidates(payerId: string, from: string, to: string, ex: Ex = this.db): Promise<Candidate[]> {
    // 0054a: ამბ. წილი წესებით — გადასათვლელი ინვოისები (ამ გადამხდელის) ჯერ გადაითვლება
    const stale = await ex.selectFrom('invoices').select('id').where('payer_shares_stale', '=', true)
      .where((eb) => eb.or([eb('insurance_payer_id', '=', payerId), eb('state_payer_id', '=', payerId)])).execute();
    for (const s of stale) {
      if (ex.isTransaction) await applyOpdRules(ex as Trx, s.id, { onlyStale: true });
      else await this.db.transaction().execute((trx) => applyOpdRules(trx, s.id, { onlyStale: true })).catch(() => undefined);
    }
    return (await sql<Candidate>`
      SELECT 'ipd' AS kind, i.id AS invoice_id, min(sp.id::text)::uuid AS stay_payer_id, sp.payer_id, CASE WHEN py.kind = 'state' THEN 'state' ELSE 'insurance' END AS share_slot,
             sum(sp.covered_amount)::text AS claimed, to_char(fin_local_date(i.finalized_at), 'YYYY-MM-DD') AS case_date, i.invoice_number, st.adm_no,
             p.last_name || ' ' || p.first_name AS patient, p.personal_number, max(sp.policy_no) AS policy_no, max(sp.guarantee_no) AS guarantee_no
        FROM stay_payers sp JOIN inpatient_stays st ON st.encounter_id = sp.encounter_id JOIN invoices i ON i.encounter_id = st.encounter_id
        JOIN payers py ON py.id = sp.payer_id JOIN patients p ON p.id = st.patient_id
       WHERE sp.payer_id = ${payerId} AND sp.status = 'active' AND sp.covered_amount > 0 AND st.status <> 'cancelled' AND i.finalized_at IS NOT NULL
         AND fin_local_date(i.finalized_at) BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id AND ci.payer_id = sp.payer_id)
       GROUP BY i.id, sp.payer_id, py.kind, i.finalized_at, i.invoice_number, st.adm_no, p.last_name, p.first_name, p.personal_number
      UNION ALL
      SELECT 'opd', i.id, NULL, x.payer_id, x.slot, x.amount::text, to_char(fin_local_date(i.created_at), 'YYYY-MM-DD'), i.invoice_number, NULL,
             p.last_name || ' ' || p.first_name, p.personal_number, NULL, NULL
        FROM invoices i JOIN encounters e ON e.id = i.encounter_id JOIN patients p ON p.id = e.patient_id
        CROSS JOIN LATERAL (VALUES (i.insurance_payer_id, 'insurance', i.insurance_share), (i.state_payer_id, 'state', i.state_share)) AS x(payer_id, slot, amount)
       WHERE x.payer_id = ${payerId} AND x.amount > 0 AND e.status::text <> 'cancelled'
         AND NOT EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)
         AND fin_local_date(i.created_at) BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id AND ci.payer_id = x.payer_id)
       ORDER BY 7, 8`.execute(ex)).rows;
  }

  async list(q: { status?: string; payer_id?: string }) {
    await this.c.rules();
    const today = await this.c.today();
    let x = this.db.selectFrom('fin_claims as c').innerJoin('payers as p', 'p.id', 'c.payer_id')
      .select(['c.id', 'c.claim_no', 'c.status', 'c.payer_id', 'p.name as payer_name', 'p.kind as payer_kind', 'c.period_from', 'c.period_to', 'c.total_claimed', 'c.total_paid',
        'c.total_resolved', 'c.sent_at', 'c.due_date', 'c.created_at',
        sql<string>`c.total_claimed - c.total_paid - c.total_resolved`.as('outstanding'),
        sql<number>`(SELECT count(*)::int FROM fin_claim_items ci WHERE ci.claim_id = c.id)`.as('items'),
        sql<number | null>`CASE WHEN c.status IN ('sent', 'partial') THEN ${today}::date - c.due_date END`.as('days_overdue')])
      .orderBy('c.created_at', 'desc').limit(500);
    if (q.status === 'open') x = x.where('c.status', 'in', ['sent', 'partial']);
    else if (q.status === 'overdue') x = x.where('c.status', 'in', ['sent', 'partial']).where('c.due_date', '<', today);
    else if (q.status) x = x.where('c.status', 'in', q.status.split(','));
    if (q.payer_id) x = x.where('c.payer_id', '=', q.payer_id);
    return x.execute();
  }

  async get(id: string, ex: Ex = this.db) {
    const c = await ex.selectFrom('fin_claims as c').innerJoin('payers as p', 'p.id', 'c.payer_id').innerJoin('users as u', 'u.id', 'c.created_by')
      .leftJoin('users as us', 'us.id', 'c.sent_by').leftJoin('users as uc', 'uc.id', 'c.cancelled_by')
      .selectAll('c').select(['p.name as payer_name', 'p.code as payer_code', 'p.kind as payer_kind', 'p.payment_terms_days', userName('u').as('created_by_name'),
        userName('us').as('sent_by_name'), userName('uc').as('cancelled_by_name'), sql<string>`c.total_claimed - c.total_paid - c.total_resolved`.as('outstanding')])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('ქლეიმი ვერ მოიძებნა');
    const items = await ex.selectFrom('fin_claim_items as ci').innerJoin('invoices as i', 'i.id', 'ci.invoice_id').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
      .innerJoin('patients as p', 'p.id', 'e.patient_id').leftJoin('inpatient_stays as st', 'st.encounter_id', 'i.encounter_id').leftJoin('stay_payers as sp', 'sp.id', 'ci.stay_payer_id')
      .leftJoin('users as ur', 'ur.id', 'ci.resolved_by')
      .select(['ci.id', 'ci.kind', 'ci.invoice_id', 'ci.share_slot', 'ci.claimed', 'ci.paid', 'ci.resolution', 'ci.resolved_amount', 'ci.resolution_reason', 'ci.resolved_at',
        userName('ur').as('resolved_by_name'), OUTSTANDING.as('outstanding'), 'i.invoice_number', 'st.adm_no', 'e.id as encounter_id', 'p.personal_number',
        sql<string>`p.last_name || ' ' || p.first_name`.as('patient'), 'sp.policy_no', 'sp.guarantee_no',
        sql<string>`to_char(CASE WHEN st.encounter_id IS NOT NULL THEN fin_local_date(i.finalized_at) ELSE fin_local_date(i.created_at) END, 'YYYY-MM-DD')`.as('case_date')])
      .where('ci.claim_id', '=', id).orderBy(sql`case_date`).orderBy('i.invoice_number').execute();
    const payments = await ex.selectFrom('fin_claim_payments as cp').innerJoin('users as u', 'u.id', 'cp.created_by').leftJoin('users as uv', 'uv.id', 'cp.voided_by')
      .select(['cp.id', 'cp.paid_on', 'cp.amount', 'cp.ref_no', 'cp.note', 'cp.is_void', 'cp.void_reason', 'cp.created_at', userName('u').as('created_by_name'), userName('uv').as('voided_by_name'),
        sql<number>`(SELECT count(*)::int FROM fin_claim_allocations a WHERE a.payment_id = cp.id)`.as('items')])
      .where('cp.claim_id', '=', id).orderBy('cp.paid_on').orderBy('cp.created_at').execute();
    // 0057: შემოწმება — მონახაზში და გაგზავნილში (ნაშთით)
    const sc = c.status === 'draft' || c.status === 'sent' ? await this.scrubItems(ex, c.payer_id, items) : new Map<string, ScrubResult>();
    const withScrub = items.map((x) => {
      const r = sc.get(x.id);
      return { ...x, scrub: r ? { errors: r.errors, warnings: r.warnings, overridden: r.overridden, issues: r.issues.filter((i) => !i.overridden).map((i) => ({ code: i.code, severity: i.severity, message: i.message, detail: i.detail })) } : null };
    });
    return { ...c, payer_kind_ka: PAYER_KIND_KA[c.payer_kind], items: withScrub, payments,
      scrub: sc.size ? { errors: [...sc.values()].filter((r) => r.errors).length, warnings: [...sc.values()].filter((r) => !r.errors && r.warnings).length } : null };
  }

  // ---------------------------------------------------------------- 0057: შემოწმება (claim scrubber)
  /** claim_check = block → შეცდომიანი შემთხვევები (გამონაკლისის გარეშე) ქლეიმში არ შედის; აბრუნებს დარჩენილს და გამოტოვებულს */
  private async scrubFilter(trx: Trx, cand: Candidate[]) {
    const sc = await scrubSettings(trx);
    if (!sc.enabled || sc.claim_check !== 'block' || !cand.length) return { ok: cand, skipped: [] as { invoice_number: string; patient: string; errors: string }[] };
    const rules = await loadRules(trx);
    const ok: Candidate[] = []; const skipped: { invoice_number: string; patient: string; errors: string }[] = [];
    for (const c of cand) {
      const r = await scrubInvoice(trx, c.invoice_id, { payerId: c.payer_id, rules });
      if (r.errors) skipped.push({ invoice_number: c.invoice_number, patient: c.patient, errors: errorText(r) }); else ok.push(c);
    }
    return { ok, skipped };
  }
  /** ქლეიმის შემთხვევების შემოწმება (გადამხდელის ჭრილში): item_id → შედეგი */
  private async scrubItems(ex: Ex, payerId: string, items: { id: string; invoice_id: string }[]) {
    const out = new Map<string, ScrubResult>();
    const sc = await scrubSettings(ex);
    if (!sc.enabled || sc.claim_check === 'off') return out;
    const rules = await loadRules(ex);
    for (const it of items) out.set(it.id, await scrubInvoice(ex, it.invoice_id, { payerId, rules }));
    return out;
  }

  // ---------------------------------------------------------------- მონახაზი
  async create(dto: { payer_id: string; period_from: string; period_to: string; notes?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    if (dto.period_from > dto.period_to) throw new BadRequestException('პერიოდი: from ≤ to');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const p = await trx.selectFrom('payers').select(['id', 'name', 'is_active']).where('id', '=', dto.payer_id).executeTakeFirst();
        if (!p) throw new BadRequestException('გადამხდელი ვერ მოიძებნა');
        const all = await this.candidates(dto.payer_id, dto.period_from, dto.period_to, trx);
        if (!all.length) throw new BadRequestException(`„${p.name}“: პერიოდში ქლეიმში შესატანი შემთხვევა არ არის (ან უკვე სხვა ქლეიმშია)`);
        const { ok: cand, skipped } = await this.scrubFilter(trx, all);
        if (!cand.length) throw new ConflictException({ code: 'SCRUB_ERRORS', message: `ყველა შემთხვევას (${skipped.length}) აქვს შემოწმების შეცდომა — გაასწორეთ ან დაუშვით გამონაკლისი`, skipped });
        const c = await trx.insertInto('fin_claims').values({ payer_id: dto.payer_id, period_from: dto.period_from, period_to: dto.period_to, notes: dto.notes?.trim() || null, created_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        await this.insertItems(trx, c.id, cand);
        await this.audit.log(ctx, { action: 'FIN_CLAIM_CREATE', entityName: 'fin_claims', entityId: c.id, newData: { payer: p.name, period_from: dto.period_from, period_to: dto.period_to, items: cand.length,
          scrub_skipped: skipped.length } }, trx);
        return { ...(await this.get(c.id, trx)), scrub_skipped: skipped };
      });
    } catch (e) { return pg(e); }
  }
  private async insertItems(trx: Trx, claimId: string, cand: Candidate[]) {
    for (const x of cand) {
      await trx.insertInto('fin_claim_items').values({ claim_id: claimId, invoice_id: x.invoice_id, payer_id: x.payer_id, stay_payer_id: x.stay_payer_id, kind: x.kind,
        share_slot: x.share_slot, claimed: x.claimed }).execute();
    }
  }
  private async lockClaim(trx: Trx, id: string) {
    const c = await trx.selectFrom('fin_claims').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundException('ქლეიმი ვერ მოიძებნა');
    return c;
  }
  /** მონახაზი: ახალი შემთხვევების დამატება (პერიოდი / შენიშვნა შეიძლება შეიცვალოს) */
  async update(id: string, dto: { period_from?: string; period_to?: string; notes?: string | null }, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.lockClaim(trx, id);
        if (c.status !== 'draft') throw new ConflictException('ქლეიმი გაგზავნილია — მხოლოდ მონახაზი იცვლება');
        const from = dto.period_from ?? c.period_from; const to = dto.period_to ?? c.period_to;
        if (from > to) throw new BadRequestException('პერიოდი: from ≤ to');
        await trx.updateTable('fin_claims').set({ period_from: from, period_to: to, ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }) }).where('id', '=', id).execute();
        // პერიოდს გარეთ დარჩენილი შემთხვევები გამოდის, ახლები ემატება
        const items = await trx.selectFrom('fin_claim_items as ci').innerJoin('invoices as i', 'i.id', 'ci.invoice_id').select(['ci.id', 'ci.kind',
          sql<string>`to_char(CASE WHEN ci.kind = 'ipd' THEN fin_local_date(i.finalized_at) ELSE fin_local_date(i.created_at) END, 'YYYY-MM-DD')`.as('d')]).where('ci.claim_id', '=', id).execute();
        const out = items.filter((x) => x.d < from || x.d > to).map((x) => x.id);
        if (out.length) await trx.deleteFrom('fin_claim_items').where('id', 'in', out).execute();
        const { ok: cand, skipped } = await this.scrubFilter(trx, await this.candidates(c.payer_id, from, to, trx));
        await this.insertItems(trx, id, cand);
        await this.audit.log(ctx, { action: 'FIN_CLAIM_UPDATE', entityName: 'fin_claims', entityId: id, newData: { period_from: from, period_to: to, added: cand.length, removed: out.length, scrub_skipped: skipped.length } }, trx);
        return { ...(await this.get(id, trx)), scrub_skipped: skipped };
      });
    } catch (e) { return pg(e); }
  }
  async removeItem(id: string, itemId: string, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.lockClaim(trx, id);
        if (c.status !== 'draft') throw new ConflictException('ქლეიმი გაგზავნილია — შემადგენლობა აღარ იცვლება');
        const r = await trx.deleteFrom('fin_claim_items').where('id', '=', itemId).where('claim_id', '=', id).returning(['invoice_id', 'claimed']).executeTakeFirst();
        if (!r) throw new NotFoundException('შემთხვევა ქლეიმში ვერ მოიძებნა');
        await this.audit.log(ctx, { action: 'FIN_CLAIM_ITEM_REMOVE', entityName: 'fin_claims', entityId: id, oldData: r }, trx);
        return this.get(id, trx);
      });
    } catch (e) { return pg(e); }
  }
  /** მონახაზი — იშლება; გაგზავნილი (ანაზღაურებისა და გადაწყვეტის გარეშე) — უქმდება მიზეზით, შემთხვევები თავისუფლდება */
  async cancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.lockClaim(trx, id);
        if (!['draft', 'sent'].includes(c.status)) throw new ConflictException('გაუქმება — მხოლოდ მონახაზი ან გაგზავნილი, ანაზღაურების / გადაწყვეტის გარეშე');
        const pays = await trx.selectFrom('fin_claim_payments').select(sql<number>`count(*)::int`.as('n')).where('claim_id', '=', id).where('is_void', '=', false).executeTakeFirstOrThrow();
        if (pays.n) throw new ConflictException('ქლეიმს აქვს ანაზღაურება — ჯერ გააუქმეთ ანაზღაურება');
        await trx.updateTable('fin_claims').set({ status: 'cancelled', cancelled_at: sql`now()`, cancelled_by: u.id, cancel_reason: reason.trim() }).where('id', '=', id).execute();
        await trx.deleteFrom('fin_claim_items').where('claim_id', '=', id).execute();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_CANCEL', entityName: 'fin_claims', entityId: id, oldData: { status: c.status, total_claimed: c.total_claimed }, newData: { reason } }, trx);
        return this.get(id, trx);
      });
    } catch (e) { return pg(e); }
  }

  // ---------------------------------------------------------------- გაგზავნა
  async send(id: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.lockClaim(trx, id);
        if (c.status !== 'draft') throw new ConflictException('ქლეიმი უკვე გაგზავნილია');
        const cnt = await trx.selectFrom('fin_claim_items').select(sql<number>`count(*)::int`.as('n')).where('claim_id', '=', id).executeTakeFirstOrThrow();
        if (!cnt.n) throw new BadRequestException('ქლეიმი ცარიელია');
        // 0057: გაგზავნამდე — ხელახალი შემოწმება (claim_check = block)
        const sc = await scrubSettings(trx);
        if (sc.enabled && sc.claim_check === 'block') {
          const its = await trx.selectFrom('fin_claim_items as ci').innerJoin('invoices as i', 'i.id', 'ci.invoice_id').select(['ci.id', 'ci.invoice_id', 'i.invoice_number'])
            .where('ci.claim_id', '=', id).execute();
          const res = await this.scrubItems(trx, c.payer_id, its);
          const bad = its.filter((x) => (res.get(x.id)?.errors ?? 0) > 0).map((x) => ({ item_id: x.id, invoice_number: x.invoice_number, errors: errorText(res.get(x.id)!) }));
          if (bad.length) throw new ConflictException({ code: 'SCRUB_ERRORS', message: `შემოწმება: ${bad.length} შემთხვევას აქვს შეცდომა — გაასწორეთ, დაუშვით გამონაკლისი ან ამოიღეთ ქლეიმიდან (${bad.slice(0, 3).map((b) => b.invoice_number).join(', ')}${bad.length > 3 ? ' …' : ''})`, items: bad });
        }
        const p = await trx.selectFrom('payers').select('payment_terms_days').where('id', '=', c.payer_id).executeTakeFirstOrThrow();
        const today = await this.c.today(trx);
        const no = await this.c.nextNo(trx, 'CL', today);
        await trx.updateTable('fin_claims').set({ status: 'sent', claim_no: no, sent_at: sql`now()`, sent_by: u.id, due_date: addDays(today, p.payment_terms_days) }).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_SEND', entityName: 'fin_claims', entityId: id, newData: { claim_no: no, total: c.total_claimed, due_days: p.payment_terms_days } }, trx);
        return this.get(id, trx);
      });
    } catch (e) { return pg(e); }
  }

  // ---------------------------------------------------------------- ანაზღაურება
  async pay(id: string, dto: { paid_on: string; amount: number; ref_no?: string | null; note?: string | null; allocations?: { item_id: string; amount: number }[] },
            u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    const today = await this.c.today();
    if (dto.paid_on > today) throw new BadRequestException('ანაზღაურების თარიღი მომავალში ვერ იქნება');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.lockClaim(trx, id);
        if (!['sent', 'partial'].includes(c.status)) throw new ConflictException('ანაზღაურება — მხოლოდ გაგზავნილ, დაუფარავ ქლეიმზე');
        const items = await trx.selectFrom('fin_claim_items as ci').select(['ci.id', OUTSTANDING.as('outstanding')]).where('ci.claim_id', '=', id).orderBy('ci.id').forUpdate().execute();
        const open = r2(items.reduce((s, x) => s + n(x.outstanding), 0));
        if (dto.amount > open + 0.001) throw new ConflictException(`ანაზღაურება (${dto.amount.toFixed(2)}) აღემატება დაუფარავ ნაშთს (${open.toFixed(2)})`);
        let alloc: { item_id: string; amount: number }[];
        if (dto.allocations?.length) {
          const sum = r2(dto.allocations.reduce((s, a) => s + a.amount, 0));
          if (Math.abs(sum - dto.amount) > 0.001) throw new BadRequestException(`განაწილების ჯამი (${sum.toFixed(2)}) ≠ ანაზღაურებას (${dto.amount.toFixed(2)})`);
          for (const a of dto.allocations) {
            const it = items.find((x) => x.id === a.item_id);
            if (!it) throw new BadRequestException('განაწილება: შემთხვევა ამ ქლეიმს არ ეკუთვნის');
            if (a.amount > n(it.outstanding) + 0.001) throw new ConflictException('განაწილება აღემატება შემთხვევის ნაშთს');
          }
          alloc = dto.allocations.filter((a) => a.amount > 0);
        } else {
          // ავტომატურად — შემთხვევების რიგით, ნაშთამდე
          let rest = dto.amount; alloc = [];
          for (const it of items) {
            if (rest <= 0) break;
            const a = r2(Math.min(rest, n(it.outstanding)));
            if (a > 0) { alloc.push({ item_id: it.id, amount: a }); rest = r2(rest - a); }
          }
        }
        const p = await trx.insertInto('fin_claim_payments').values({ claim_id: id, paid_on: dto.paid_on, amount: dto.amount.toFixed(2), ref_no: dto.ref_no?.trim() || null,
          note: dto.note?.trim() || null, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        for (const a of alloc) await trx.insertInto('fin_claim_allocations').values({ payment_id: p.id, item_id: a.item_id, amount: a.amount.toFixed(2) }).execute();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_PAYMENT', entityName: 'fin_claims', entityId: id, newData: { payment_id: p.id, ...dto, allocations: alloc } }, trx);
        return this.get(id, trx);
      });
    } catch (e) { return pg(e); }
  }
  async voidPayment(paymentId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const p = await trx.selectFrom('fin_claim_payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirst();
        if (!p) throw new NotFoundException('ანაზღაურება ვერ მოიძებნა');
        if (p.is_void) throw new ConflictException('ანაზღაურება უკვე გაუქმებულია');
        await this.lockClaim(trx, p.claim_id);
        await trx.updateTable('fin_claim_payments').set({ is_void: true, void_reason: reason.trim(), voided_by: u.id, voided_at: sql`now()` }).where('id', '=', paymentId).execute();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_PAYMENT_VOID', entityName: 'fin_claims', entityId: p.claim_id, oldData: { payment_id: p.id, amount: p.amount, paid_on: p.paid_on }, newData: { reason } }, trx);
        return this.get(p.claim_id, trx);
      });
    } catch (e) { return pg(e); }
  }

  // ---------------------------------------------------------------- დანაკლისის / უარის გადაწყვეტა
  async resolve(itemId: string, dto: { action: 'patient' | 'writeoff'; amount?: number; reason: string }, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const it = await trx.selectFrom('fin_claim_items as ci').selectAll('ci').select(OUTSTANDING.as('outstanding')).where('ci.id', '=', itemId).forUpdate().executeTakeFirst();
        if (!it) throw new NotFoundException('შემთხვევა ვერ მოიძებნა');
        const c = await this.lockClaim(trx, it.claim_id);
        if (!['sent', 'partial'].includes(c.status)) throw new ConflictException('გადაწყვეტა — მხოლოდ გაგზავნილ, დაუფარავ ქლეიმზე');
        if (it.resolution) throw new ConflictException('შემთხვევა უკვე გადაწყვეტილია');
        const out = n(it.outstanding);
        const amount = r2(dto.amount ?? out);
        if (amount <= 0 || amount > out + 0.001) throw new BadRequestException(`თანხა: 0 < x ≤ ${out.toFixed(2)} (დაუფარავი)`);
        if (dto.action === 'patient') {
          // წილი გადადის პაციენტზე: ინვოისის დაზღვევის / სახელმწიფოს წილი მცირდება (ტრიგერი — პაციენტის წილი იზრდება); სტაციონარი — stay_payers.covered_amount
          await sql`SELECT set_config('emr.fin_resolution', 'on', true)`.execute(trx);
          const inv = await trx.selectFrom('invoices').select(['id', 'insurance_share', 'state_share']).where('id', '=', it.invoice_id).forUpdate().executeTakeFirstOrThrow();
          const slot = it.share_slot === 'state' ? 'state_share' : 'insurance_share';
          const cur = n(inv[slot]);
          if (cur + 0.001 < amount) throw new ConflictException(`ინვოისის წილი (${cur.toFixed(2)}) ნაკლებია გადასატან თანხაზე`);
          await trx.updateTable('invoices').set(slot === 'state_share' ? { state_share: r2(cur - amount).toFixed(2) } : { insurance_share: r2(cur - amount).toFixed(2) }).where('id', '=', inv.id).execute();
          if (it.kind === 'ipd') {
            const sps = await trx.selectFrom('stay_payers as sp').innerJoin('invoices as i', 'i.encounter_id', 'sp.encounter_id').select(['sp.id', 'sp.covered_amount'])
              .where('i.id', '=', it.invoice_id).where('sp.payer_id', '=', it.payer_id).where('sp.status', '=', 'active').orderBy('sp.seq', 'desc').execute();
            let rest = amount;
            for (const s of sps) {
              if (rest <= 0) break;
              const d = r2(Math.min(rest, n(s.covered_amount)));
              if (d > 0) { await trx.updateTable('stay_payers').set({ covered_amount: r2(n(s.covered_amount) - d).toFixed(2) }).where('id', '=', s.id).execute(); rest = r2(rest - d); }
            }
          }
          await sql`SELECT fin_line_shares_to_patient(${it.invoice_id}::uuid, ${it.payer_id}::uuid, ${amount}::numeric)`.execute(trx);   // 0054a
          await sql`SELECT set_config('emr.fin_resolution', 'off', true)`.execute(trx);
        }
        await trx.updateTable('fin_claim_items').set({ resolution: dto.action, resolved_amount: amount.toFixed(2), resolution_reason: dto.reason.trim(), resolved_by: u.id, resolved_at: sql`now()` })
          .where('id', '=', itemId).execute();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_RESOLVE', entityName: 'fin_claim_items', entityId: itemId,
          newData: { claim_id: it.claim_id, invoice_id: it.invoice_id, action: dto.action, amount, reason: dto.reason } }, trx);
        return this.get(it.claim_id, trx);
      });
    } catch (e) { return pg(e); }
  }

  // ---------------------------------------------------------------- CSV / დებიტორები
  async csv(id: string, ctx: AuditContext) {
    await this.c.rules();
    const c = await this.get(id);
    const head = ['№', 'ტიპი', 'ჰოსპ. №', 'ინვოისი', 'თარიღი', 'პაციენტი', 'პირადი №', 'პოლისი', 'საგარანტიო', 'მოთხოვნილი', 'ანაზღაურებული', 'გადაწყვეტილი', 'ნაშთი', 'შემოწმება'];
    const rows = c.items.map((x, i) => [i + 1, x.kind === 'ipd' ? 'სტაციონარი' : 'ამბულატორია', x.adm_no, x.invoice_number, x.case_date, x.patient, x.personal_number, x.policy_no,
      x.guarantee_no, n(x.claimed).toFixed(2), n(x.paid).toFixed(2), n(x.resolved_amount).toFixed(2), n(x.outstanding).toFixed(2),
      x.scrub ? x.scrub.issues.map((i) => `${i.severity === 'error' ? '✗' : '⚠'} ${i.message}${i.detail ? ` (${i.detail})` : ''}`).join(' | ') : '']);
    rows.push(['', '', '', '', '', 'ჯამი', '', '', '', n(c.total_claimed).toFixed(2), n(c.total_paid).toFixed(2), n(c.total_resolved).toFixed(2), n(c.outstanding).toFixed(2), '']);
    await this.audit.log(ctx, { action: 'FIN_CLAIM_EXPORT', entityName: 'fin_claims', entityId: id, newData: { items: c.items.length } });
    return { name: `claim-${c.claim_no ?? 'draft'}-${c.payer_code}.csv`,
      csv: toCsv(head, rows, `${c.payer_name} (${c.payer_code}); ${c.claim_no ?? 'მონახაზი'}; ${c.period_from} — ${c.period_to}`) };
  }

  /** გადამხდელის დებიტორები თარიღით: ქლეიმში შეუტანელი, მონახაზი, გაგზავნილის ნაშთი ვადაგადაცილებით */
  async receivables(asOf?: string) {
    await this.c.rules();
    const d = asOf ?? await this.c.today();
    if (!DATE_RE.test(d)) throw new BadRequestException('as_of: YYYY-MM-DD');
    const open = await this.db.selectFrom('fin_claim_items as ci').innerJoin('fin_claims as c', 'c.id', 'ci.claim_id')
      .select(['c.payer_id', 'c.status', 'c.due_date', OUTSTANDING.as('outstanding')]).where('c.status', 'in', ['draft', 'sent', 'partial']).execute();
    const payers = await this.db.selectFrom('payers').select(['id', 'name', 'code', 'kind', 'payment_terms_days']).execute();
    type R = { payer_id: string; payer_name: string; kind: string; unclaimed: number; draft: number; not_due: number; d1_30: number; d31_60: number; d61_90: number; d90: number; outstanding: number; total: number };
    const by = new Map<string, R>();
    const row = (id: string) => {
      let r = by.get(id);
      if (!r) { const p = payers.find((x) => x.id === id)!; r = { payer_id: id, payer_name: p.name, kind: p.kind, unclaimed: 0, draft: 0, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, outstanding: 0, total: 0 }; by.set(id, r); }
      return r;
    };
    for (const x of open) {
      const r = row(x.payer_id); const amt = n(x.outstanding);
      if (amt <= 0) continue;
      if (x.status === 'draft') { r.draft = r2(r.draft + amt); continue; }
      const late = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${x.due_date}T00:00:00Z`)) / 86_400_000);
      const k = late <= 0 ? 'not_due' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90';
      r[k] = r2(r[k] + amt); r.outstanding = r2(r.outstanding + amt);
    }
    for (const p of payers) {
      const cand = await this.candidates(p.id, '2000-01-01', d);
      if (cand.length) { const r = row(p.id); r.unclaimed = r2(cand.reduce((s, x) => s + n(x.claimed), 0)); }
    }
    for (const r of by.values()) r.total = r2(r.unclaimed + r.draft + r.outstanding);
    const list = [...by.values()].filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
    const sum = (k: keyof Omit<R, 'payer_id' | 'payer_name' | 'kind'>) => r2(list.reduce((s, x) => s + x[k], 0));
    return { as_of: d, rows: list.map((r) => ({ ...r, kind_ka: PAYER_KIND_KA[r.kind] })),
      totals: { unclaimed: sum('unclaimed'), draft: sum('draft'), not_due: sum('not_due'), d1_30: sum('d1_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), d90: sum('d90'),
        outstanding: sum('outstanding'), total: sum('total') } };
  }

  async summary() {
    const today = await this.c.today();
    const r = await this.db.selectFrom('fin_claims as c').select([
      sql<number>`count(*) FILTER (WHERE c.status = 'draft')::int`.as('drafts'),
      sql<number>`count(*) FILTER (WHERE c.status IN ('sent', 'partial'))::int`.as('open'),
      sql<number>`count(*) FILTER (WHERE c.status IN ('sent', 'partial') AND c.due_date < ${today}::date)::int`.as('overdue'),
      sql<string>`coalesce(sum(c.total_claimed - c.total_paid - c.total_resolved) FILTER (WHERE c.status IN ('sent', 'partial')), 0)`.as('outstanding'),
    ]).executeTakeFirstOrThrow();
    return { ...r, outstanding: String(r2(n(r.outstanding))) };
  }
}

// ======================================================================= DTO
class ClaimDto { @IsUUID() payer_id: string; @IsISO8601({ strict: true }) period_from: string; @IsISO8601({ strict: true }) period_to: string; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null }
class ClaimUpdDto { @IsOptional() @IsISO8601({ strict: true }) period_from?: string; @IsOptional() @IsISO8601({ strict: true }) period_to?: string; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null }
class AllocDto { @IsUUID() item_id: string; @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000_000) amount: number }
class ClaimPayDto {
  @IsISO8601({ strict: true }) paid_on: string; @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1_000_000_000) amount: number;
  @IsOptional() @IsString() @MaxLength(60) ref_no?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => AllocDto) allocations?: AllocDto[];
}
class ResolveDto { @IsIn(['patient', 'writeoff']) action: 'patient' | 'writeoff'; @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount?: number; @IsString() @Length(3, 500) reason: string }
class ReasonDto { @IsString() @Length(3, 500) reason: string }

@Controller('finance')
export class FinClaimsController {
  constructor(private readonly s: FinClaimsService, private readonly c: FinCommon) {}
  @Get('claims/summary') @Roles(...FIN_FULL, 'billing') summary() { return this.s.summary(); }
  @Get('claims') @Roles(...FIN_FULL, 'billing') list(@Query('status') status?: string, @Query('payer_id') payer?: string) {
    if (payer && !/^[0-9a-f-]{36}$/i.test(payer)) throw new BadRequestException('payer_id');
    return this.s.list({ status, payer_id: payer });
  }
  @Get('claims/candidates') @Roles(...FIN_FULL) async candidates(@Query('payer_id') payer: string, @Query('from') from: string, @Query('to') to: string) {
    await this.c.rules();
    if (!payer || !/^[0-9a-f-]{36}$/i.test(payer)) throw new BadRequestException('payer_id სავალდებულოა');
    const p = this.c.period(from, to);
    return this.s.candidates(payer, p.from, p.to);
  }
  @Get('claims/:id') @Roles(...FIN_FULL, 'billing') one(@Param('id', ParseUUIDPipe) id: string) { return this.s.get(id); }
  @Get('claims/:id/csv') @Roles(...FIN_FULL, 'billing')
  async csv(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.csv(id, auditCtx(r));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.name}"` });
    return out.csv;
  }
  @Post('claims') @Roles(...FIN_EDIT) create(@Body() d: ClaimDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Put('claims/:id') @Roles(...FIN_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ClaimUpdDto, @Req() r: Request) { return this.s.update(id, d, auditCtx(r)); }
  @Delete('claims/:id/items/:itemId') @Roles(...FIN_EDIT) removeItem(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) item: string, @Req() r: Request) {
    return this.s.removeItem(id, item, auditCtx(r));
  }
  @Post('claims/:id/send') @HttpCode(200) @Roles(...FIN_EDIT) send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.send(id, u, auditCtx(r)); }
  @Post('claims/:id/cancel') @HttpCode(200) @Roles(...FIN_EDIT) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.cancel(id, d.reason, u, auditCtx(r));
  }
  @Post('claims/:id/payments') @HttpCode(200) @Roles(...FIN_EDIT) pay(@Param('id', ParseUUIDPipe) id: string, @Body() d: ClaimPayDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.pay(id, d, u, auditCtx(r));
  }
  @Post('claim-payments/:id/void') @HttpCode(200) @Roles(...FIN_EDIT) voidPay(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.voidPayment(id, d.reason, u, auditCtx(r));
  }
  @Post('claim-items/:id/resolve') @HttpCode(200) @Roles(...CLAIM_RESOLVE) resolve(@Param('id', ParseUUIDPipe) id: string, @Body() d: ResolveDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.resolve(id, d, u, auditCtx(r));
  }
  @Get('receivables') @Roles(...FIN_FULL) receivables(@Query('as_of') asOf?: string) { return this.s.receivables(asOf); }
}
