import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { writeXlsx, type Cell } from '../claims-export/xlsx';
import { toCsv } from '../finance/finance-common';
import { PAYER_KIND_KA } from '../finance/finance-rules';
import { DATE_RE, daysBetween, n, r1, r2, RPT_READ, RptCommon, type RptScope } from './reporting-common';
import { doctorAccess } from './reporting-ops';

/**
 * ფინანსური დაფა (0063) — მხოლოდ rpt_* ფაქტებიდან:
 *  • summary — შემოსავალი (სახეებით), ხარჯი, შედეგი, მარჟა, გადახდები, 13 თვე, განყოფილებები, გადამხდელები;
 *  • balances — დებიტორები (გადამხდელი / პაციენტი) და კრედიტორები (მომწოდებელი) ვადაგადაცილებით + თვის ბოლოს ტრენდი (მხოლოდ კლინიკის ხედვა);
 *  • doctors — შემოსავალი ექიმზე: შემსრულებელი / დამნიშნავი (doctor_revenue + doctor_breakdown + ფინანსების ხედვა).
 */
type Q = Record<string, string | undefined>;
export const CAT_KA: Record<string, string> = {
  bed: 'საწოლდღე', ventilation: 'ხელოვნური ვენტილაცია', surgery: 'ოპერაცია', anesthesia: 'ანესთეზია', service: 'მომსახურება', consult: 'კონსულტაცია', lab: 'ლაბორატორია',
  radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია', medication: 'მედიკამენტი', supply: 'სამედიცინო მასალა', implant: 'იმპლანტი', package: 'პაკეტი', other: 'სხვა',
};
export const BASIS_KA: Record<string, string> = { performer: 'შემსრულებელი', referrer: 'დამნიშნავი' };
const NET = ['patient', 'insurance', 'state', 'other', 'undetermined'] as const;
const BAL_KA: Record<string, string> = { ar_payer: 'გადამხდელები (დებიტორები)', ar_patient: 'პაციენტის ვალი', ap: 'მომწოდებლები (კრედიტორები)' };
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const monthsBack = (to: string, count: number) => {
  const out: string[] = []; const [y, m] = to.split('-').map(Number);
  for (let i = count - 1; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
};

@Injectable()
export class ReportingFinService {
  constructor(private readonly c: RptCommon, private readonly audit: AuditService) {}
  private get rdb() { return this.c.rdb; }

  private period(q: Q) {
    if (!q.from || !q.to || !DATE_RE.test(q.from) || !DATE_RE.test(q.to) || q.from > q.to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (daysBetween(q.from, q.to) > 3 * 366) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    return { from: q.from, to: q.to };
  }
  private finOnly(scope: RptScope) {
    if (!scope.finance) throw new ForbiddenException({ code: 'FINANCE_HIDDEN', message: 'ფინანსური მაჩვენებლები თქვენთვის არ ჩანს (ფინანსების მოდული / უფლება / dept_finance_visible)' });
  }
  async ctx(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const base = await this.c.scope(u);
    const scope = this.c.narrow(base, q.department_id);
    this.finOnly(scope);
    return { s, base, scope, ...this.period(q) };
  }
  private where(scope: RptScope, col: string) { return scope.all ? sql`TRUE` : sql`${sql.ref(col)} = ANY(${scope.depts}::uuid[])`; }
  private range(from: string, to: string, col = 'f.day') { return sql`${sql.ref(col)} BETWEEN ${from}::date AND ${to}::date`; }
  private async closedMonths() {
    return (await this.rdb.selectFrom('fin_periods').select('month').where('status', '=', 'closed').execute()).map((r) => String(r.month).slice(0, 7));
  }

  // ------------------------------------------------------------------------------------ შეჯამება
  async summary(u: AuthUser, q: Q) {
    const { scope, from, to } = await this.ctx(u, q);
    const W = this.where(scope, 'f.department_id');
    const agg = sql`coalesce(sum(f.rev_patient), 0)::text AS patient, coalesce(sum(f.rev_insurance), 0)::text AS insurance, coalesce(sum(f.rev_state), 0)::text AS state,
      coalesce(sum(f.rev_other), 0)::text AS other, coalesce(sum(f.rev_undetermined), 0)::text AS undetermined, coalesce(sum(f.rev_writeoff), 0)::text AS writeoff,
      coalesce(sum(f.rev_denied), 0)::text AS denied, coalesce(sum(f.stock_cost), 0)::text AS stock_cost, coalesce(sum(f.expenses), 0)::text AS expenses,
      coalesce(sum(f.payments), 0)::text AS payments`;
    type A = Record<'patient' | 'insurance' | 'state' | 'other' | 'undetermined' | 'writeoff' | 'denied' | 'stock_cost' | 'expenses' | 'payments', string>;
    const calc = (a: A) => {
      const keys = ['patient', 'insurance', 'state', 'other', 'undetermined', 'writeoff', 'denied', 'stock_cost', 'expenses', 'payments'] as const;
      const v = Object.fromEntries(keys.map((k) => [k, r2(n(a[k]))])) as Record<keyof A, number>;   // მხოლოდ თანხები (id / სახელი არ გადაიწეროს)
      const rev_net = r2(NET.reduce((s, k) => s + v[k], 0)); const costs = r2(v.stock_cost + v.expenses); const result = r2(rev_net - costs);
      return { ...v, rev_net, costs, result, margin_pct: pct(result, rev_net), collection_pct: pct(v.payments, rev_net) };
    };
    const tot = (await sql<A>`SELECT ${agg} FROM rpt_fact_finance f WHERE ${this.range(from, to)} AND ${W}`.execute(this.rdb)).rows[0];
    const months = monthsBack(to, 13);
    const mrows = (await sql<A & { m: string }>`SELECT to_char(f.day, 'YYYY-MM') AS m, ${agg} FROM rpt_fact_finance f
       WHERE ${this.range(`${months[0]}-01`, to)} AND ${W} GROUP BY 1`.execute(this.rdb)).rows;
    const zero = { patient: '0', insurance: '0', state: '0', other: '0', undetermined: '0', writeoff: '0', denied: '0', stock_cost: '0', expenses: '0', payments: '0' };
    const drows = (await sql<A & { department_id: string | null; department_name: string | null }>`
      SELECT f.department_id, d.name AS department_name, ${agg} FROM rpt_fact_finance f LEFT JOIN departments d ON d.id = f.department_id
       WHERE ${this.range(from, to)} AND ${W} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const prow = (await sql<{ payer_id: string | null; name: string | null; kind: string; amount: string }>`
      SELECT f.payer_id, p.name, f.kind, sum(f.amount)::text AS amount FROM rpt_fact_payer f LEFT JOIN payers p ON p.id = f.payer_id
       WHERE ${this.range(from, to)} AND ${W} GROUP BY 1, 2, 3`.execute(this.rdb)).rows;
    const total = calc(tot);
    const closed = await this.closedMonths();
    const inRange = monthsBack(to, Math.min(40, Math.ceil(daysBetween(from, to) / 28) + 1)).filter((m) => monthEnd(m) >= from && `${m}-01` <= to);
    const kinds = (['patient', 'insurance', 'state', 'other', 'undetermined', 'writeoff', 'denied'] as const).map((k) => ({ kind: k, name: PAYER_KIND_KA[k], amount: total[k],
      share_pct: NET.includes(k as never) ? pct(total[k], total.rev_net) : null }));
    const payers = prow.filter((p) => p.payer_id && NET.includes(p.kind as never)).reduce((m, p) => {
      const r = m.get(p.payer_id!) ?? { payer_id: p.payer_id!, name: p.name ?? '—', kind: p.kind, kind_ka: PAYER_KIND_KA[p.kind], amount: 0 };
      r.amount = r2(r.amount + n(p.amount)); m.set(p.payer_id!, r); return m;
    }, new Map<string, { payer_id: string; name: string; kind: string; kind_ka: string; amount: number }>());
    return { from, to, department_id: q.department_id ?? null, scope_all: scope.all, totals: total, kinds,
      payers: [...payers.values()].map((p) => ({ ...p, share_pct: pct(p.amount, total.rev_net) })).sort((a, b) => b.amount - a.amount),
      monthly: months.map((m) => { const r = mrows.find((x) => x.m === m); return { month: m, closed: closed.includes(m), ...calc(r ?? zero) }; }),
      departments: drows.map((d) => ({ department_id: d.department_id, department_name: d.department_name ?? 'განყოფილების გარეშე (საერთო)', ...calc(d) }))
        .filter((d) => d.rev_net || d.costs || d.payments).sort((a, b) => b.rev_net - a.rev_net),
      closed_months: inRange.filter((m) => closed.includes(m)), open_months: inRange.filter((m) => !closed.includes(m)) };
  }

  // ------------------------------------------------------------------------------------ დებიტორები / კრედიტორები
  async balances(u: AuthUser, q: Q) {
    await this.c.settings();
    const scope = await this.c.scope(u);
    this.finOnly(scope);
    if (!scope.all) throw new ForbiddenException({ code: 'BALANCES_ALL_ONLY', message: 'დებიტორები / კრედიტორები ჩანს მხოლოდ კლინიკის ხედვით' });
    if (q.as_of && !DATE_RE.test(q.as_of)) throw new BadRequestException('as_of: YYYY-MM-DD');
    const asOf = q.as_of ?? await this.c.today();
    const day = (await sql<{ d: string | null }>`SELECT to_char(max(day), 'YYYY-MM-DD') AS d FROM rpt_balance_snapshot WHERE day <= ${asOf}::date`.execute(this.rdb)).rows[0].d;
    const rows = day ? (await sql<{ kind: string; party_id: string | null; party_name: string; party_kind: string | null; unclaimed: string; draft: string; not_due: string; d1_30: string;
      d31_60: string; d61_90: string; d90: string; total: string; items: number; computed_at: Date }>`
      SELECT kind, party_id, party_name, party_kind, unclaimed::text, draft::text, not_due::text, d1_30::text, d31_60::text, d61_90::text, d90::text, total::text, items, computed_at
        FROM rpt_balance_snapshot WHERE day = ${day}::date ORDER BY total DESC`.execute(this.rdb)).rows : [];
    const cols = ['unclaimed', 'draft', 'not_due', 'd1_30', 'd31_60', 'd61_90', 'd90', 'total'] as const;
    const conv = (r: (typeof rows)[number]) => ({ party_id: r.party_id, party_name: r.party_name, party_kind: r.party_kind, party_kind_ka: r.party_kind ? PAYER_KIND_KA[r.party_kind] ?? r.party_kind : null,
      items: r.items, ...Object.fromEntries(cols.map((k) => [k, r2(n(r[k]))])) as Record<(typeof cols)[number], number> });
    const group = (kind: string) => {
      const list = rows.filter((r) => r.kind === kind).map(conv);
      return { kind, name: BAL_KA[kind], rows: list, totals: Object.fromEntries(cols.map((k) => [k, r2(list.reduce((s, x) => s + x[k], 0))])) as Record<(typeof cols)[number], number> };
    };
    // თვის ბოლოს ტრენდი: თვის ბოლო სურათი (იმავე თვეში)
    const months = monthsBack(asOf, 13);
    const tr = (await sql<{ m: string; kind: string; total: string }>`
      WITH last AS (SELECT to_char(day, 'YYYY-MM') AS m, max(day) AS d FROM rpt_balance_snapshot WHERE day BETWEEN ${`${months[0]}-01`}::date AND ${asOf}::date GROUP BY 1)
      SELECT last.m, b.kind, sum(b.total)::text AS total FROM last JOIN rpt_balance_snapshot b ON b.day = last.d GROUP BY 1, 2`.execute(this.rdb)).rows;
    return { as_of: asOf, snapshot_day: day, computed_at: rows[0]?.computed_at ?? null, ar_payer: group('ar_payer'), ar_patient: group('ar_patient'), ap: group('ap'),
      trend: months.map((m) => {
        const v = (k: string) => { const x = tr.find((t) => t.m === m && t.kind === k); return x ? r2(n(x.total)) : null; };
        const has = tr.some((t) => t.m === m);
        return { month: m, ar_payer: has ? v('ar_payer') ?? 0 : null, ar_patient: has ? v('ar_patient') ?? 0 : null, ap: has ? v('ap') ?? 0 : null };
      }) };
  }

  // ------------------------------------------------------------------------------------ ექიმის შემოსავალი
  async doctors(u: AuthUser, q: Q, ctx: AuditContext | null) {
    const s = await this.c.settings();
    if (s.doctor_revenue === 'off') throw new ForbiddenException({ code: 'DOCTOR_REVENUE_OFF', message: 'შემოსავალი ექიმზე გამორთულია (მოდულები → მენეჯერული რეპორტინგი → doctor_revenue)' });
    const base = await this.c.scope(u);
    doctorAccess(s, base);
    const scope = this.c.narrow(base, q.department_id);
    this.finOnly(scope);
    const { from, to } = this.period(q);
    const basis = q.basis ?? 'performer';
    if (!BASIS_KA[basis]) throw new BadRequestException('basis: performer / referrer');
    const rows = (await sql<{ doctor_id: string | null; doctor_name: string | null; kind: string; category: string; amount: string }>`
      SELECT f.doctor_id, u.last_name || ' ' || u.first_name AS doctor_name, f.kind, f.category, sum(f.amount)::text AS amount
        FROM rpt_fact_doctor_rev f LEFT JOIN users u ON u.id = f.doctor_id
       WHERE ${this.range(from, to)} AND f.basis = ${basis} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2, 3, 4`.execute(this.rdb)).rows;
    type R = { doctor_id: string | null; doctor_name: string; net: number; patient: number; insurance: number; state: number; other: number; undetermined: number; writeoff: number;
      denied: number; cats: Record<string, number> };
    const m = new Map<string, R>();
    for (const x of rows) {
      const k = x.doctor_id ?? '';
      const r = m.get(k) ?? { doctor_id: x.doctor_id, doctor_name: x.doctor_name ?? 'ექიმი მითითებული არ არის', net: 0, patient: 0, insurance: 0, state: 0, other: 0, undetermined: 0,
        writeoff: 0, denied: 0, cats: {} };
      const v = n(x.amount);
      if (x.kind in r) (r as unknown as Record<string, number>)[x.kind] += v;
      if (NET.includes(x.kind as never)) { r.net += v; r.cats[x.category] = (r.cats[x.category] ?? 0) + v; }
      m.set(k, r);
    }
    const all = [...m.values()];
    const totalNet = r2(all.reduce((s2, r) => s2 + r.net, 0));
    const out = all.map((r) => ({
      doctor_id: r.doctor_id, doctor_name: r.doctor_name, unassigned: !r.doctor_id,
      net: r2(r.net), patient: r2(r.patient), insurance: r2(r.insurance), state: r2(r.state), other: r2(r.other), undetermined: r2(r.undetermined), writeoff: r2(r.writeoff), denied: r2(r.denied),
      share_pct: pct(r.net, totalNet),
      categories: Object.entries(r.cats).map(([k, v]) => ({ category: k, name: CAT_KA[k] ?? k, amount: r2(v) })).filter((c) => c.amount).sort((a, b) => b.amount - a.amount),
    })).filter((r) => r.net || r.writeoff || r.denied).sort((a, b) => (a.unassigned === b.unassigned ? b.net - a.net : a.unassigned ? 1 : -1));
    if (ctx) await this.audit.log(ctx, { action: 'REPORT_DOCTOR_REVENUE', entityName: 'rpt_fact_doctor_rev', entityId: basis,
      newData: { from, to, department_id: q.department_id ?? null, rows: out.length } });
    return { from, to, basis, basis_ka: BASIS_KA[basis], total_net: totalNet, rows: out };
  }

  // ------------------------------------------------------------------------------------ ექსპორტი
  async export(u: AuthUser, q: Q, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'csv'].includes(format)) throw new BadRequestException('format: xlsx / csv');
    const ds = q.dataset ?? '';
    let header: string[] = []; let rows: Cell[][] = []; let title = '';
    if (ds === 'departments') {
      const o = await this.summary(u, q); title = `ფინანსები განყოფილებებით ${o.from} — ${o.to}`;
      header = ['განყოფილება', 'შემოსავალი (წმინდა)', 'პაციენტი', 'დაზღვევა', 'სახელმწიფო', 'სხვა', 'დაუზუსტებელი', 'მარაგის ხარჯი', 'ხარჯები', 'შედეგი', 'მარჟა %', 'გადახდები'];
      rows = o.departments.map((d) => [d.department_name, d.rev_net, d.patient, d.insurance, d.state, d.other, d.undetermined, d.stock_cost, d.expenses, d.result, d.margin_pct, d.payments]);
    } else if (ds === 'payers') {
      const o = await this.summary(u, q); title = `შემოსავალი გადამხდელებით ${o.from} — ${o.to}`;
      header = ['გადამხდელი', 'სახე', 'შემოსავალი', 'წილი %'];
      rows = [...o.kinds.filter((k) => k.amount && !['insurance', 'state', 'other'].includes(k.kind)).map((k) => [k.name, '', k.amount, k.share_pct] as Cell[]),
        ...o.payers.map((p) => [p.name, p.kind_ka, p.amount, p.share_pct] as Cell[])];
    } else if (ds === 'ar' || ds === 'ap') {
      const o = await this.balances(u, q); title = `${ds === 'ar' ? 'დებიტორები' : 'კრედიტორები'} ${o.snapshot_day ?? o.as_of}`;
      header = ['მხარე', 'სახე', 'შეუტანელი', 'მონახაზი', 'ვადამდე', '1–30', '31–60', '61–90', '90+', 'სულ', 'ჩანაწერი'];
      const groups = ds === 'ar' ? [o.ar_payer, o.ar_patient] : [o.ap];
      rows = groups.flatMap((g) => g.rows.map((r) => [r.party_name, r.party_kind_ka ?? g.name, r.unclaimed, r.draft, r.not_due, r.d1_30, r.d31_60, r.d61_90, r.d90, r.total, r.items] as Cell[]));
    } else if (ds === 'doctors') {
      const o = await this.doctors(u, q, null); title = `შემოსავალი ექიმზე (${o.basis_ka}) ${o.from} — ${o.to}`;
      header = ['ექიმი', 'შემოსავალი (წმინდა)', 'წილი %', 'პაციენტი', 'დაზღვევა', 'სახელმწიფო', 'სხვა', 'დაუზუსტებელი', 'ჩამოწერა', 'უარი', 'კატეგორიები'];
      rows = o.rows.map((r) => [r.doctor_name, r.net, r.share_pct, r.patient, r.insurance, r.state, r.other, r.undetermined, r.writeoff, r.denied,
        r.categories.map((c) => `${c.name} ${c.amount}`).join('; ')]);
    } else throw new BadRequestException('dataset: departments / payers / ar / ap / doctors');
    await this.audit.log(auditCtx(req), { action: 'REPORT_EXPORT', entityName: 'rpt_reports', entityId: `fin_${ds}`,
      newData: { format, from: q.from ?? null, to: q.to ?? null, as_of: q.as_of ?? null, basis: q.basis ?? null, department_id: q.department_id ?? null, rows: rows.length, phi: false } });
    const base = `rpt_fin_${ds}_${q.from ?? q.as_of ?? ''}_${q.to ?? ''}`.replace(/_+$/, '');
    if (format === 'csv') return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(header, rows.map((r) => r.map((c) => (typeof c === 'object' && c !== null ? c.v : c))), title), 'utf8') };
    return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: writeXlsx({ name: ds, header, rows: rows.map((r) => r.map((c) => (typeof c === 'number' ? { v: c, fmt: Number.isInteger(c) ? '0' : '#,##0.00' } : c))),
        widths: header.map((h, i) => Math.min(60, Math.max(8, h.length + 2, ...rows.slice(0, 100).map((r) => String((r[i] as string | number | null) ?? '').length + 2)))) }) };
  }
}
@Controller('reporting/fin')
export class ReportingFinController {
  constructor(private readonly s: ReportingFinService) {}
  @Get('summary') @Roles(...RPT_READ) summary(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.summary(u, q); }
  @Get('balances') @Roles(...RPT_READ) balances(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.balances(u, q); }
  @Get('doctors') @Roles(...RPT_READ) doctors(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.doctors(u, q, auditCtx(r)); }
  @Get('export') @Roles(...RPT_READ)
  async export(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}
