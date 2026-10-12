import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, Param, Post, Req } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { FinClaimsService } from './finance-claims';
import { FinCommon, n, r2, userName } from './finance-common';
import { FinReportsService } from './finance-reports';
import { FIN_EDIT, FIN_FULL } from './finance-rules';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const shift = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return d.toISOString().slice(0, 7); };

/**
 * ფინანსური პერიოდი (0053): ბუღალტერი კეტავს თვეს (period_lock = on → DB ტრიგერები დახურულ თვეში ცვლილებას ბლოკავენ, 409);
 * დახურვამდე — შემოწმების სია (გაფრთხილებები, არ ბლოკავს); დახურვისას — სნეპშოტი; გახსნა — მიზეზით, აუდიტით, შეტყობინებით.
 */
@Injectable()
export class FinPeriodsService {
  constructor(private readonly c: FinCommon, private readonly reports: FinReportsService, private readonly claims: FinClaimsService, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async list() {
    const rules = await this.c.rules();
    const today = await this.c.today();
    const cur = today.slice(0, 7);
    const rows = await this.db.selectFrom('fin_periods as p').leftJoin('users as uc', 'uc.id', 'p.closed_by').leftJoin('users as ur', 'ur.id', 'p.reopened_by')
      .select(['p.month', 'p.status', 'p.closed_at', 'p.note', 'p.reopened_at', 'p.reopen_reason', 'p.snapshot', 'p.checklist', userName('uc').as('closed_by_name'), userName('ur').as('reopened_by_name')])
      .execute();
    const months = new Set<string>(rows.map((r) => String(r.month).slice(0, 7)));
    for (let k = 0; k < 12; k++) months.add(shift(cur, -k));
    const list = [...months].filter((m) => m <= cur).sort().reverse().map((m) => {
      const r = rows.find((x) => String(x.month).slice(0, 7) === m);
      return { month: m, status: r?.status ?? 'open', closable: monthEnd(m) < today, closed_at: r?.closed_at ?? null, closed_by_name: r?.closed_by_name ?? null, note: r?.note ?? null,
        reopened_at: r?.reopened_at ?? null, reopened_by_name: r?.reopened_by_name ?? null, reopen_reason: r?.reopen_reason ?? null, snapshot: r?.snapshot ?? null,
        locked: rules.period_lock === 'on' && r?.status === 'closed' };
    });
    const log = await this.db.selectFrom('fin_period_log as l').innerJoin('users as u', 'u.id', 'l.user_id')
      .select(['l.id', sql<string>`to_char(l.month, 'YYYY-MM')`.as('month'), 'l.action', 'l.reason', 'l.created_at', userName('u').as('user_name')]).orderBy('l.created_at', 'desc').limit(50).execute();
    return { period_lock: rules.period_lock, today, periods: list, log };
  }

  /** დახურვამდე შემოწმება — გაფრთხილებები (დახურვას არ ბლოკავს) */
  async checklist(month: string) {
    await this.c.rules();
    if (!MONTH_RE.test(month)) throw new BadRequestException('თვე: YYYY-MM');
    const a = `${month}-01`, b = monthEnd(month);
    const one = async (q: Promise<{ n: number; amount?: string | null } | undefined>) => { const r = await q; return { n: r?.n ?? 0, amount: r?.amount ? r2(n(r.amount)) : null }; };
    const ap = await one(this.db.selectFrom('ap_invoices').select([sql<number>`count(*)::int`.as('n'), sql<string>`sum(total_gel)`.as('amount')])
      .where('status', '=', 'draft').where('invoice_date', '>=', a).where('invoice_date', '<=', b).executeTakeFirst());
    const mismatch = await one(this.db.selectFrom('ap_invoices').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'posted').where('match_status', '=', 'mismatch')
      .where('invoice_date', '>=', a).where('invoice_date', '<=', b).executeTakeFirst());
    const stock = await one(this.db.selectFrom('stock_docs').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'draft').where('doc_date', '>=', a).where('doc_date', '<=', b).executeTakeFirst());
    const ipd = await one(this.db.selectFrom('inpatient_stays as st').innerJoin('invoices as i', 'i.encounter_id', 'st.encounter_id')
      .select([sql<number>`count(*)::int`.as('n'), sql<string>`sum(i.total_amount)`.as('amount')]).where('st.status', '=', 'discharged').where('i.finalized_at', 'is', null)
      .where(sql<string>`fin_local_date(st.ended_at)`, '>=', a).where(sql<string>`fin_local_date(st.ended_at)`, '<=', b).executeTakeFirst());
    const noPayer = await one(this.db.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
      .select([sql<number>`count(*)::int`.as('n'), sql<string>`sum(i.insurance_share + i.state_share)`.as('amount')])
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)`).where(sql`e.status::text`, '<>', 'cancelled')
      .where((eb) => eb.or([eb.and([eb('i.insurance_share', '>', '0'), eb('i.insurance_payer_id', 'is', null)]), eb.and([eb('i.state_share', '>', '0'), eb('i.state_payer_id', 'is', null)])]))
      .where(sql<string>`fin_local_date(i.created_at)`, '>=', a).where(sql<string>`fin_local_date(i.created_at)`, '<=', b).executeTakeFirst());
    const payers = await this.db.selectFrom('payers').select('id').execute();
    let unclaimedN = 0, unclaimedAmt = 0;
    for (const p of payers) { const c = await this.claims.candidates(p.id, a, b); unclaimedN += c.length; unclaimedAmt += c.reduce((s, x) => s + n(x.claimed), 0); }
    const drafts = await one(this.db.selectFrom('fin_claims').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'draft').executeTakeFirst());
    const items = [
      { code: 'ap_draft', label: 'მომწოდებლის ინვოისი — მონახაზი (თვის თარიღით)', ...ap },
      { code: 'ap_mismatch', label: 'მომწოდებლის ინვოისი — შეჯერების სხვაობა დაუდასტურებელი', ...mismatch },
      { code: 'stock_draft', label: 'მარაგის დოკუმენტი — მონახაზი (თვის თარიღით)', ...stock },
      { code: 'ipd_unfinalized', label: 'გაწერილი სტაციონარი — ფინანსურად დაუხურავი', ...ipd },
      { code: 'opd_no_payer', label: 'ამბულატორია — დაზღვევის / სახელმწიფოს წილი გადამხდელის გარეშე', ...noPayer },
      { code: 'unclaimed', label: 'გადამხდელის წილი — ქლეიმში შეუტანელი', n: unclaimedN, amount: unclaimedN ? r2(unclaimedAmt) : null },
      { code: 'claim_draft', label: 'ქლეიმი — მონახაზი (გაუგზავნელი)', ...drafts },
    ];
    return { month, from: a, to: b, items, warnings: items.filter((x) => x.n > 0).length };
  }

  async close(month: string, note: string | undefined, u: AuthUser, ctx: AuditContext) {
    const rules = await this.c.rules();
    if (!MONTH_RE.test(month)) throw new BadRequestException('თვე: YYYY-MM');
    const today = await this.c.today();
    const a = `${month}-01`, b = monthEnd(month);
    if (b >= today) throw new BadRequestException('დახურვა — მხოლოდ დასრულებული თვე');
    const check = await this.checklist(month);
    // სნეპშოტი: დახურვის მომენტის ციფრები (შემდგომი ცვლილება — მხოლოდ გახსნით)
    const all = { dept: null, dept_name: null };
    const rev = await this.reports.revenueData(rules, all, a, b, rules.revenue_basis, rules.revenue_dept_basis);
    const cons = await this.reports.consumptionData(all, a, b, rules.dept_consumption_basis);
    const val = await this.reports.stockValueData(all, b);
    const exp = await this.db.selectFrom('expenses').select(sql<string>`coalesce(sum(amount), 0)`.as('amount')).where('is_void', '=', false)
      .where('expense_date', '>=', a).where('expense_date', '<=', b).executeTakeFirstOrThrow();
    const paid = await this.db.selectFrom('payments').select(sql<string>`coalesce(sum(amount) FILTER (WHERE method <> 'deposit'), 0)`.as('amount'))
      .where(sql<string>`fin_local_date(paid_at)`, '>=', a).where(sql<string>`fin_local_date(paid_at)`, '<=', b).executeTakeFirstOrThrow();
    const snapshot = {
      revenue_basis: rev.basis, revenue: rev.totals, revenue_by_department: rev.by_department.map((r) => ({ department: r.department_name, total: r.total, net: r.net })),
      expenses: r2(n(exp.amount)), patient_payments: r2(n(paid.amount)),
      stock_basis: cons.basis, stock_cost: cons.totals.cost, stock_loss: cons.totals.loss, stock_value_end: val.total, costing_method: val.costing_method,
      warnings: check.items.filter((x) => x.n > 0).map((x) => ({ code: x.code, n: x.n, amount: x.amount })),
    };
    return this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('fin_periods').select('status').where('month', '=', a).forUpdate().executeTakeFirst();
      if (cur?.status === 'closed') throw new ConflictException(`პერიოდი ${month} უკვე დახურულია`);
      const vals = { status: 'closed', closed_at: sql<string>`now()`, closed_by: u.id, note: note?.trim() || null, checklist: JSON.stringify(check.items), snapshot: JSON.stringify(snapshot) };
      if (cur) await trx.updateTable('fin_periods').set(vals).where('month', '=', a).execute();
      else await trx.insertInto('fin_periods').values({ month: a, ...vals }).execute();
      await trx.insertInto('fin_period_log').values({ month: a, action: 'close', reason: note?.trim() || null, data: JSON.stringify({ warnings: snapshot.warnings }), user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'FIN_PERIOD_CLOSE', entityName: 'fin_periods', entityId: month, newData: { note, snapshot, period_lock: rules.period_lock } }, trx);
      return { month, status: 'closed', locked: rules.period_lock === 'on', snapshot, checklist: check.items };
    });
  }

  async reopen(month: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    if (!MONTH_RE.test(month)) throw new BadRequestException('თვე: YYYY-MM');
    const a = `${month}-01`;
    const out = await this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('fin_periods').select(['status', 'snapshot']).where('month', '=', a).forUpdate().executeTakeFirst();
      if (cur?.status !== 'closed') throw new ConflictException(`პერიოდი ${month} დახურული არ არის`);
      await trx.updateTable('fin_periods').set({ status: 'open', reopened_at: sql`now()`, reopened_by: u.id, reopen_reason: reason.trim() }).where('month', '=', a).execute();
      await trx.insertInto('fin_period_log').values({ month: a, action: 'reopen', reason: reason.trim(), user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'FIN_PERIOD_REOPEN', entityName: 'fin_periods', entityId: month, oldData: { status: 'closed', snapshot: cur.snapshot }, newData: { reason } }, trx);
      return { month, status: 'open' };
    });
    const ids = await this.c.usersWith(['accountant', 'admin']);
    await this.c.notify(ids, { kind: 'fin_period', title: `ფინანსური პერიოდი ${month} გაიხსნა`, body: `${u.name}: ${reason.trim()}`, urgent: false, entityId: null, link: '/finance/periods' }, u.id);
    return out;
  }
}

class CloseDto { @IsOptional() @IsString() @MaxLength(500) note?: string }
class ReasonDto { @IsString() @Length(3, 500) reason: string }

@Controller('finance/periods')
export class FinPeriodsController {
  constructor(private readonly s: FinPeriodsService) {}
  @Get() @Roles(...FIN_FULL) list() { return this.s.list(); }
  @Get(':month/checklist') @Roles(...FIN_FULL) checklist(@Param('month') m: string) { return this.s.checklist(m); }
  @Post(':month/close') @HttpCode(200) @Roles(...FIN_EDIT) close(@Param('month') m: string, @Body() d: CloseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.close(m, d.note, u, auditCtx(r)); }
  @Post(':month/reopen') @HttpCode(200) @Roles(...FIN_EDIT) reopen(@Param('month') m: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reopen(m, d.reason, u, auditCtx(r)); }
}
