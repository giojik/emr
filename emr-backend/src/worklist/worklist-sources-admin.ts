import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { StockAlertsService } from '../stock/stock-alerts';
import { stockRules } from '../stock/stock-rules';
import { procRules } from '../procurement/procurement-rules';
import { finRules } from '../finance/finance-rules';
import { TZ, WL_DEFAULTS, dayEnd, memberDepts, type Priority, type SlaKey, type WlItem, type WlSettings } from './worklist-common';

/**
 * სამუშაო სიები (D5), 0082 — ადმინისტრაცია / ლოჯისტიკის სისტემური წყაროები (ვირტუალური, როგორც 0081).
 *
 * A1 — სამოქმედო უფლება ≠ პასუხისმგებლობა: ჩანაწერი ჩნდება ლოკაციის / ობიექტის „ბუნებრივ მფლობელთან“
 *   (განყოფილების ლოკაცია → განყოფილება; საწყობი → მესაწყობე / საწყობის მენეჯერი; აფთიაქი → ფარმაცევტი; ლაბ. → ლაბ. როლები;
 *   CSSD → ერთეულის განყოფილება). ზოგადი უფლება (stock_manager …) — მხოლოდ მფლობელის არარსებობისას. admin — არასდროს (0081).
 * B1 — განყოფილების მხარე (dept_side): heads — ხელმძღვანელი (is_section_head / manager), უხელმძღვანელო განყოფილებაში — ყველა წევრი; all — ყველა წევრი.
 * C1 — მასობრივი წყაროები — ერთი ჩანაწერი ლოკაციაზე / გადამხდელზე / ქლეიმზე.
 * F1 — sla_hours: ვადა გაგზავნიდან, სადაც წყაროს თავისი ვადა არ აქვს.
 */
export type Row = Omit<WlItem, 'key' | 'kind' | 'group' | 'overdue' | 'due_at' | 'created_at' | 'due_date_only'> & { id: string; due_at: Date | string | null; created_at?: Date | string | null; due_date_only?: boolean };
export interface SourceGroup { module: string; codes: string[]; fetch: (u: AuthUser, codes: Set<string>, ctx: AdminCtx) => Promise<Row[]> }

const LIMIT = 200;
const TODAY = sql<string>`(now() AT TIME ZONE ${TZ})::date`;
const uuids = (xs: Iterable<string>) => { const a = [...xs]; return a.length ? a : ['00000000-0000-0000-0000-000000000000']; };
const money = (v: string | number | null | undefined) => `${Number(v ?? 0).toFixed(2)} ₾`;
type Loc = { id: string; name: string; kind: string; department_id: string | null };

/** ერთი მოთხოვნის კონტექსტი: მომხმარებლის განყოფილება / ხელმძღვანელობა / ლოკაციების ფლობა (memo) */
export class AdminCtx {
  private memo = new Map<string, Promise<unknown>>();
  constructor(readonly db: Database, readonly u: AuthUser, readonly s: WlSettings) {}
  private m<T>(k: string, f: () => Promise<T>): Promise<T> {
    if (!this.memo.has(k)) this.memo.set(k, f());
    return this.memo.get(k) as Promise<T>;
  }
  sla(k: SlaKey, base: Date | string | null | undefined): Date | null {
    const h = { ...WL_DEFAULTS.sla_hours, ...(this.s.sla_hours ?? {}) }[k];
    if (!h || !base) return null;
    return new Date(new Date(base).getTime() + h * 3600_000);
  }
  me() {
    return this.m('me', () => this.db.selectFrom('users').select(['department_id', 'is_section_head']).where('id', '=', this.u.id).executeTakeFirstOrThrow());
  }
  async isHead() { return !!(await this.me()).is_section_head || has(this.u, 'manager'); }
  /** განყოფილებები, რომლებსაც აქტიური ხელმძღვანელი ჰყავს (users.department_id + is_section_head / manager) */
  heads() {
    return this.m('heads', async () => new Set((await sql<{ id: string }>`
      SELECT DISTINCT u.department_id AS id FROM users u LEFT JOIN user_capabilities c ON c.user_id = u.id
       WHERE u.is_active AND u.department_id IS NOT NULL AND (u.is_section_head OR 'manager' = ANY (coalesce(c.capabilities, '{}')))`.execute(this.db)).rows.map((x) => x.id)));
  }
  /** განყოფილებები, რომლებსაც ერთი აქტიური წევრი მაინც ჰყავს (users / D4 თანამშრომელი) */
  peopled() {
    return this.m('peopled', async () => new Set((await sql<{ id: string }>`
      SELECT department_id AS id FROM users WHERE is_active AND department_id IS NOT NULL
      UNION SELECT s.department_id FROM staff_members s JOIN users u ON u.id = s.user_id WHERE s.is_active AND u.is_active AND s.department_id IS NOT NULL
      UNION SELECT x.department_id FROM staff_member_departments x JOIN staff_members s ON s.id = x.staff_id JOIN users u ON u.id = s.user_id WHERE s.is_active AND u.is_active`.execute(this.db)).rows.map((x) => x.id)));
  }
  members() { return this.m('members', () => memberDepts(this.db, this.u.id)); }
  /** B1: განყოფილების მხარე — რომელ განყოფილებებზე ვარ პასუხისმგებელი */
  deptSide() {
    return this.m('deptSide', async () => {
      const mem = await this.members();
      if (this.s.dept_side === 'all') return new Set(mem);
      const [me, head, heads] = await Promise.all([this.me(), this.isHead(), this.heads()]);
      return new Set(mem.filter((d) => (head && d === me.department_id) || !heads.has(d)));
    });
  }
  /** აქვს თუ არა კლინიკაში ვინმეს (აქტიურს) ეს უფლება */
  capExists(cap: Role) {
    return this.m(`cap:${cap}`, async () => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM users u JOIN user_capabilities c ON c.user_id = u.id
      WHERE u.is_active AND ${cap} = ANY (c.capabilities)`.execute(this.db)).rows[0].n > 0);
  }
  locs() {
    return this.m('locs', () => this.db.selectFrom('stock_locations').select(['id', 'name', 'kind', 'department_id']).where('is_active', '=', true).where('kind', '<>', 'transit').execute() as Promise<Loc[]>);
  }
  /** A1: ლოკაციის ბუნებრივი მფლობელი (მიღება / გაცემა) */
  ownerLocs() {
    return this.m('ownerLocs', async () => {
      const [locs, side, peopled, me, noPharm] = await Promise.all([this.locs(), this.deptSide(), this.peopled(), this.me(), this.capExists('pharmacist').then((x) => !x)]);
      const store = has(this.u, 'storekeeper', 'stock_manager');
      const out = new Set<string>();
      for (const l of locs) {
        const own = l.kind === 'pharmacy' ? has(this.u, 'pharmacist') || (noPharm && store)
          : l.kind === 'lab' ? has(this.u, 'lab_manager', 'lab_doctor', 'diagnostic')
            : l.kind === 'cssd' ? (l.department_id ? me.department_id === l.department_id : has(this.u, 'stock_manager'))
              : l.department_id ? side.has(l.department_id) || (!peopled.has(l.department_id) && has(this.u, 'stock_manager'))
                : store;
        if (own) out.add(l.id);
      }
      return out;
    });
  }
  /** დილის შეტყობინების მიმღებები (StockAlerts.recipients) — admin-ის გარეშე: ვადა / მინიმუმი */
  alertLocs() {
    return this.m('alertLocs', async () => {
      const [locs, heads, me, head] = await Promise.all([this.locs(), this.heads(), this.me(), this.isHead()]);
      const out = new Set<string>();
      for (const l of locs) {
        const own = l.kind === 'lab' ? has(this.u, 'lab_manager', 'lab_doctor')
          : l.kind === 'department' && l.department_id
            ? heads.has(l.department_id) ? me.department_id === l.department_id && head && has(this.u, 'nurse', 'doctor', 'manager', 'lab_manager', 'diagnostic') : has(this.u, 'stock_manager')
            : l.kind === 'pharmacy' ? has(this.u, 'storekeeper', 'stock_manager', 'pharmacist') : has(this.u, 'storekeeper', 'stock_manager');
        if (own) out.add(l.id);
      }
      return out;
    });
  }
  /** CSSD ერთეულები (ლოკაცია), სადაც ვმუშაობ — ერთეულის განყოფილება = ჩემი (canProcess, admin / stock_manager-ის გარეშე) */
  cssdUnits() {
    return this.m('cssdUnits', async () => {
      const [locs, me] = await Promise.all([this.locs(), this.me()]);
      return new Set(locs.filter((l) => l.kind === 'cssd' && !!l.department_id && l.department_id === me.department_id).map((l) => l.id));
    });
  }
  /** რეგისტრატურის არე: null — მთელი კლინიკა; department — users.department_id ∪ rpt_user_scopes */
  regDepts() {
    return this.m('regDepts', async () => {
      if (this.s.reg_scope !== 'department') return null;
      const r = await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${this.u.id}
        UNION SELECT department_id FROM users WHERE id = ${this.u.id} AND department_id IS NOT NULL`.execute(this.db);
      return r.rows.map((x) => x.id);
    });
  }
  modSettings(code: string) {
    return this.m(`mod:${code}`, async () => ((await this.db.selectFrom('system_modules').select('settings').where('code', '=', code).executeTakeFirst())?.settings ?? {}) as Record<string, unknown>);
  }
}

const WO_REASON: Record<string, string> = { expired: 'ვადაგასული', damaged: 'დაზიანებული', lost: 'დაკარგული', department_use: 'განყოფილების ხარჯი', recall: 'გაწვევა', other: 'სხვა', lab_use: 'ლაბ. ხარჯი', cssd_use: 'CSSD ხარჯი' };

@Injectable()
export class WorklistAdminSources {
  constructor(@InjectDb() private readonly db: Database, private readonly stockAlerts: StockAlertsService) {}

  groups(): SourceGroup[] {
    return [
      { module: 'stock', codes: ['stk_approve', 'stk_issue', 'stk_receive'], fetch: (u, c, x) => this.stockFlow(u, c, x) },
      { module: 'stock', codes: ['stk_writeoff', 'stk_count', 'stk_quarantine', 'stk_empties'], fetch: (u, c, x) => this.stockControl(u, c, x) },
      { module: 'stock', codes: ['stk_expiry', 'stk_min'], fetch: (u, c, x) => this.stockLevels(u, c, x) },
      { module: 'procurement', codes: ['proc_pr_approve', 'proc_pr_order', 'proc_po_approve', 'proc_po_overdue'], fetch: (u, c, x) => this.procurement(u, c, x) },
      { module: 'procurement', codes: ['ap_match', 'ap_due'], fetch: (u, c) => this.payables(u, c) },
      { module: 'finance', codes: ['fin_claim_due', 'fin_claim_resolve', 'fin_claim_build', 'fin_period'], fetch: (u, c, x) => this.finance(u, c, x) },
      { module: 'inpatient', codes: ['bill_finalize'], fetch: (u, _c, x) => this.billFinalize(u, x) },
      { module: 'tariffs', codes: ['tariff_approve'], fetch: (u) => this.tariffs(u) },
      { module: 'cssd', codes: ['cssd_recall', 'cssd_expiry', 'cssd_bi', 'cssd_bd'], fetch: (u, c, x) => this.cssd(u, c, x) },
      { module: 'asset_register', codes: ['asset_move', 'asset_writeoff'], fetch: (u, c, x) => this.assets(u, c, x) },
      { module: 'core', codes: ['reg_appt', 'cash_debt'], fetch: (u, c, x) => this.reception(u, c, x) },
      { module: 'inpatient', codes: ['reg_planned'], fetch: (u, _c, x) => this.planned(u, x) },
    ];
  }

  // ------------------------------------------------------------------ მარაგი: მოთხოვნა → დამტკიცება → გაცემა → მიღება
  private async stockFlow(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const out: Row[] = [];
    const locs = await x.locs();
    type Rq = { id: string; req_no: string; urgent: boolean; status: string; submitted_at: Date; approved_at: Date | null; from_name: string; to_name: string; dep: string | null; n: number };
    const rq = (where: ReturnType<typeof sql>) => sql<Rq>`
      SELECT r.id, r.req_no, r.urgent, r.status, r.submitted_at, r.approved_at, f.name AS from_name, t.name AS to_name, d.name AS dep,
             (SELECT count(*)::int FROM stock_request_lines l WHERE l.request_id = r.id) AS n
        FROM stock_requests r JOIN stock_locations f ON f.id = r.from_location_id JOIN stock_locations t ON t.id = r.to_location_id
        LEFT JOIN departments d ON d.id = t.department_id
       WHERE ${where} ORDER BY r.urgent DESC, r.submitted_at LIMIT ${LIMIT}`.execute(this.db);
    if (c.has('stk_approve')) {
      // canApprove (admin-ის გარეშე): ლაბ. — lab_manager; განყოფილების გარეშე — stock_manager; განყოფილება — მისი ხელმძღვანელი / მენეჯერი
      const [me, head] = await Promise.all([x.me(), x.isHead()]);
      const ids = locs.filter((l) => (l.kind === 'lab' && has(u, 'lab_manager')) || (!l.department_id ? has(u, 'stock_manager') : head && me.department_id === l.department_id)).map((l) => l.id);
      if (ids.length) for (const r of (await rq(sql`r.status = 'submitted' AND r.to_location_id = ANY (${uuids(ids)}::uuid[])`)).rows)
        out.push({ id: r.id, source: 'stk_approve', title: `მოთხოვნა ${r.req_no} — დასამტკიცებელი`, detail: `${r.to_name} ← ${r.from_name} · ${r.n} პოზ.`,
          patient: null, department: r.dep, due_at: x.sla(r.urgent ? 'stk_urgent' : 'stk_approve', r.submitted_at), priority: r.urgent ? 'urgent' : 'normal',
          link: `/stock/requests?req=${r.id}`, created_at: r.submitted_at });
    }
    if (c.has('stk_issue') || c.has('stk_receive')) {
      const own = await x.ownerLocs();
      if (c.has('stk_issue') && own.size) for (const r of (await rq(sql`r.status IN ('approved', 'partial') AND r.from_location_id = ANY (${uuids(own)}::uuid[])`)).rows)
        out.push({ id: r.id, source: 'stk_issue', title: `მოთხოვნა ${r.req_no} — გასაცემი`, detail: `${r.from_name} → ${r.to_name}${r.status === 'partial' ? ' · ნაწილობრივ გაცემული' : ''} · ${r.n} პოზ.`,
          patient: null, department: r.dep, due_at: x.sla(r.urgent ? 'stk_urgent' : 'stk_issue', r.approved_at ?? r.submitted_at), priority: r.urgent ? 'urgent' : 'normal',
          link: `/stock/requests?req=${r.id}`, created_at: r.approved_at ?? r.submitted_at });
      if (c.has('stk_receive') && own.size) {
        const r = await sql<{ id: string; doc_no: string; doc_type: string; posted_at: Date; from_name: string; to_name: string; dep: string | null; urgent: boolean; req_no: string | null }>`
          SELECT d.id, d.doc_no, d.doc_type, d.posted_at, f.name AS from_name, t.name AS to_name, dp.name AS dep, coalesce(rq.urgent, FALSE) AS urgent, rq.req_no
            FROM stock_docs d JOIN stock_locations f ON f.id = d.from_location_id JOIN stock_locations t ON t.id = d.to_location_id
            LEFT JOIN departments dp ON dp.id = t.department_id LEFT JOIN stock_requests rq ON rq.id = d.request_id
           WHERE d.status = 'posted' AND d.receive_status IS NULL AND d.doc_type IN ('transfer', 'return') AND d.to_location_id = ANY (${uuids(own)}::uuid[])
           ORDER BY d.posted_at LIMIT ${LIMIT}`.execute(this.db);
        for (const d of r.rows) out.push({ id: d.id, source: 'stk_receive', title: `${d.doc_type === 'return' ? 'დაბრუნება' : 'გადაცემა'} ${d.doc_no} — მისაღები`,
          detail: `${d.from_name} → ${d.to_name}${d.req_no ? ` · ${d.req_no}` : ''}`, patient: null, department: d.dep,
          due_at: x.sla(d.urgent ? 'stk_urgent' : 'stk_receive', d.posted_at), priority: d.urgent ? 'urgent' : 'normal', link: '/stock/transit', created_at: d.posted_at });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ მარაგი: ჩამოწერა, ინვენტარიზაცია, კარანტინი, ცარიელი ამპულა
  private async stockControl(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const out: Row[] = [];
    if (c.has('stk_writeoff') && has(u, 'stock_manager')) {
      const r = await sql<{ id: string; doc_no: string | null; reason: string; total: string; created_at: Date; loc: string; dep: string | null; who: string }>`
        SELECT d.id, d.doc_no, d.writeoff_reason AS reason, d.total_net AS total, d.created_at, l.name AS loc, dp.name AS dep, cu.last_name || ' ' || cu.first_name AS who
          FROM stock_docs d JOIN stock_locations l ON l.id = d.location_id LEFT JOIN departments dp ON dp.id = l.department_id JOIN users cu ON cu.id = d.created_by
         WHERE d.doc_type = 'writeoff' AND d.status = 'draft' AND d.approval_status = 'pending' AND d.created_by <> ${u.id}
         ORDER BY d.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const d of r.rows) out.push({ id: d.id, source: 'stk_writeoff', title: `ჩამოწერა დასამტკიცებელია: ${d.loc}`, detail: `${WO_REASON[d.reason] ?? d.reason} · ${money(d.total)} · ${d.who}`,
        patient: null, department: d.dep, due_at: null, priority: d.reason === 'lost' ? 'high' : 'normal', link: '/stock/writeoffs', created_at: d.created_at });
    }
    if (c.has('stk_count')) {
      const lock = (await stockRules(this.db)).count_lock;
      const r = await sql<{ id: string; count_no: string; status: string; started_at: Date; submitted_at: Date | null; loc: string; dep: string | null; mine: boolean; old: boolean }>`
        SELECT k.id, k.count_no, k.status, k.started_at, k.submitted_at, l.name AS loc, dp.name AS dep, k.started_by = ${u.id} AS mine, k.started_at < now() - interval '24 hours' AS old
          FROM stock_counts k JOIN stock_locations l ON l.id = k.location_id LEFT JOIN departments dp ON dp.id = l.department_id
         WHERE (k.status = 'open' AND k.started_by = ${u.id}) OR (k.status = 'counted' AND ${has(u, 'stock_manager')})
         ORDER BY k.started_at LIMIT ${LIMIT}`.execute(this.db);
      for (const k of r.rows) out.push({ id: k.id, source: 'stk_count', title: k.status === 'open' ? `ინვენტარიზაცია ${k.count_no} — დასასრულებელი` : `ინვენტარიზაცია ${k.count_no} — დასამტკიცებელი`,
        detail: `${k.loc}${k.status === 'open' && lock ? ' · ლოკაცია დაბლოკილია' : ''}`, patient: null, department: k.dep, due_at: null,
        priority: k.status === 'open' && lock && k.old ? 'high' : 'normal', link: `/stock/counts?count=${k.id}`, created_at: k.submitted_at ?? k.started_at });
    }
    if (c.has('stk_quarantine') && has(u, 'stock_manager', 'pharmacist')) {
      const r = await sql<{ id: string; lot_no: string | null; item: string; reason: string | null; updated_at: Date; qty: string; locs: number }>`
        SELECT lt.id, lt.lot_no, i.name AS item, lt.status_reason AS reason, lt.updated_at, coalesce(sum(b.qty), 0)::text AS qty, count(DISTINCT b.location_id)::int AS locs
          FROM stock_lots lt JOIN stock_items i ON i.id = lt.item_id JOIN stock_balances b ON b.lot_id = lt.id AND b.qty > 0
         WHERE lt.status = 'quarantine' GROUP BY lt.id, i.name ORDER BY lt.updated_at LIMIT ${LIMIT}`.execute(this.db);
      for (const l of r.rows) out.push({ id: l.id, source: 'stk_quarantine', title: `ლოტი კარანტინშია: ${l.item}${l.lot_no ? ` · ${l.lot_no}` : ''}`,
        detail: `ნაშთი ${Number(l.qty)} (${l.locs} ლოკ.)${l.reason ? ` · ${l.reason}` : ''} — გააქტიურება / გაწვევა`, patient: null, department: null, due_at: null, priority: 'normal',
        link: `/stock/lots?lot=${l.id}`, created_at: l.updated_at });
    }
    if (c.has('stk_empties') && (has(u, 'pharmacist') || (has(u, 'storekeeper', 'stock_manager') && !(await x.capExists('pharmacist'))))) {
      const classes = (await stockRules(this.db)).empty_return_classes;
      if (classes.length) {
        const r = await sql<{ id: string; loc: string; dep: string | null; n: number; first: Date }>`
          SELECT l.id, l.name AS loc, dp.name AS dep, count(*)::int AS n, min(d.posted_at) AS first
            FROM stock_doc_lines x JOIN stock_docs d ON d.id = x.doc_id JOIN stock_items i ON i.id = x.item_id JOIN med_generics g ON g.id = i.generic_id
            JOIN stock_locations l ON l.id = d.location_id LEFT JOIN departments dp ON dp.id = l.department_id
           WHERE d.doc_type = 'consumption' AND d.status = 'posted' AND d.reversed_by IS NULL AND x.empty_returned_at IS NULL AND g.controlled_class = ANY (${classes}::text[])
           GROUP BY l.id, l.name, dp.name ORDER BY min(d.posted_at) LIMIT ${LIMIT}`.execute(this.db);
        for (const e of r.rows) out.push({ id: e.id, source: 'stk_empties', title: `ცარიელი ამპულა — დასადასტურებელი: ${e.loc}`, detail: `${e.n} ხაზი (ნარკოტიკული ხარჯი)`,
          patient: null, department: e.dep, due_at: null, priority: 'high', link: '/stock/controlled', created_at: e.first });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ მარაგი: ვადა / მინიმუმი (C1 — ლოკაციაზე, დილის შეტყობინების მიმღებები)
  private async stockLevels(_u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const mine = await x.alertLocs();
    if (!mine.size) return [];
    const out: Row[] = [];
    if (c.has('stk_expiry')) {
      const days = x.s.stk_expiry_days ?? 30;
      const r = await sql<{ id: string; name: string; dep: string | null; expired: number; soon: number; first: Date }>`
        SELECT l.id, l.name, dp.name AS dep, count(DISTINCT lt.id) FILTER (WHERE lt.expires_on < ${TODAY})::int AS expired,
               count(DISTINCT lt.id) FILTER (WHERE lt.expires_on >= ${TODAY})::int AS soon, ${dayEnd('min_exp')} AS first
          FROM (SELECT b.location_id, lt.id, lt.expires_on, min(lt.expires_on) OVER (PARTITION BY b.location_id) AS min_exp
                  FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id
                 WHERE b.qty > 0 AND lt.expires_on IS NOT NULL AND lt.expires_on <= ${TODAY} + ${days}::int AND b.location_id = ANY (${uuids(mine)}::uuid[])) lt
          JOIN stock_locations l ON l.id = lt.location_id LEFT JOIN departments dp ON dp.id = l.department_id
         GROUP BY l.id, l.name, dp.name, lt.min_exp ORDER BY lt.min_exp LIMIT ${LIMIT}`.execute(this.db);
      for (const l of r.rows) out.push({ id: l.id, source: 'stk_expiry', title: `ვადები — ${l.name}`,
        detail: [l.expired ? `ვადაგასული: ${l.expired} ლოტი (ჩამოსაწერი)` : '', l.soon ? `იწურება ${days} დღეში: ${l.soon} ლოტი` : ''].filter(Boolean).join('; '),
        patient: null, department: l.dep, due_at: l.first, due_date_only: true, priority: l.expired ? 'high' : 'normal',
        link: `/stock/balances?location_id=${l.id}&expiring_days=${l.expired ? -1 : days}`, created_at: null });
    }
    if (c.has('stk_min')) {
      const below = (await this.stockAlerts.belowMin()).filter((b) => mine.has(b.location_id));
      const by = new Map<string, typeof below>();
      for (const b of below) by.set(b.location_id, [...(by.get(b.location_id) ?? []), b]);
      const deps = new Map((await this.db.selectFrom('departments').select(['id', 'name']).execute()).map((d) => [d.id, d.name]));
      for (const [loc, items] of by) out.push({ id: loc, source: 'stk_min', title: `მინიმუმზე ქვემოთ — ${items[0].location_name}`,
        detail: `${items.length} პოზ.: ${items.slice(0, 4).map((i) => i.item_name).join(', ')}${items.length > 4 ? '…' : ''}`, patient: null,
        department: items[0].department_id ? deps.get(items[0].department_id) ?? null : null, due_at: null, priority: 'normal', link: `/stock/minmax?location_id=${loc}`, created_at: null });
    }
    return out;
  }

  // ------------------------------------------------------------------ შესყიდვები
  private async procurement(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const rules = await procRules(this.db);
    const out: Row[] = [];
    if (c.has('proc_pr_approve') && has(u, 'stock_manager', 'procurement_approve', 'pharmacist')) {
      // eligible() (admin-ის გარეშე): ავტორი — არა; L1 — stock_manager; ფინანსური — L1-ის შემდეგ, procurement_approve, არა L1-ის შემსრულებელი; ფარმაცევტი
      const r = await sql<{ id: string; pr_no: string; urgent: boolean; needed_by: string | null; est_total: string; submitted_at: Date; loc: string; dep: string | null; steps: string[] }>`
        SELECT p.id, p.pr_no, p.urgent, to_char(p.needed_by, 'YYYY-MM-DD') AS needed_by, p.est_total, p.submitted_at, l.name AS loc, dp.name AS dep,
               array_remove(ARRAY[
                 CASE WHEN p.l1_at IS NULL AND ${has(u, 'stock_manager')} THEN 'l1' END,
                 CASE WHEN p.needs_finance AND p.finance_at IS NULL AND p.l1_at IS NOT NULL AND p.l1_by <> ${u.id} AND ${has(u, 'procurement_approve')} THEN 'finance' END,
                 CASE WHEN p.needs_pharmacist AND p.pharm_at IS NULL AND ${has(u, 'pharmacist')} THEN 'pharmacist' END], NULL) AS steps
          FROM proc_requisitions p JOIN stock_locations l ON l.id = p.location_id LEFT JOIN departments dp ON dp.id = l.department_id
         WHERE p.status = 'submitted' AND p.created_by <> ${u.id} ORDER BY p.urgent DESC, p.submitted_at LIMIT ${LIMIT}`.execute(this.db);
      const STEP: Record<string, string> = { l1: 'დონე 1', finance: 'ფინანსური', pharmacist: 'ფარმაცევტი' };
      for (const p of r.rows.filter((y) => y.steps.length)) {
        const sla = x.sla('proc_approve', p.submitted_at);
        const need = p.needed_by ? dayEndOf(p.needed_by) : null;
        out.push({ id: p.id, source: 'proc_pr_approve', title: `შესყიდვის მოთხოვნა ${p.pr_no} — ${p.steps.map((s) => STEP[s]).join(' / ')}`,
          detail: `${p.loc} · ~${money(p.est_total)}${p.needed_by ? ` · საჭიროა ${p.needed_by}` : ''}`, patient: null, department: p.dep,
          due_at: sla && need ? (sla < need ? sla : need) : sla ?? need, priority: p.urgent ? 'high' : 'normal', link: `/procurement/requisitions?id=${p.id}`, created_at: p.submitted_at });
      }
    }
    if (c.has('proc_pr_order') && rules.po_mode !== 'off' && (has(u, 'procurement') || (has(u, 'stock_manager') && !(await x.capExists('procurement'))))) {
      const r = await sql<{ id: string; pr_no: string; urgent: boolean; needed_by: string | null; est_total: string; approved: Date; loc: string; dep: string | null }>`
        SELECT p.id, p.pr_no, p.urgent, to_char(p.needed_by, 'YYYY-MM-DD') AS needed_by, p.est_total, greatest(p.l1_at, p.finance_at, p.pharm_at) AS approved, l.name AS loc, dp.name AS dep
          FROM proc_requisitions p JOIN stock_locations l ON l.id = p.location_id LEFT JOIN departments dp ON dp.id = l.department_id
         WHERE p.status = 'approved' AND NOT EXISTS (SELECT 1 FROM proc_requisition_lines pl JOIN proc_order_lines ol ON ol.requisition_line_id = pl.id
                 JOIN proc_orders o ON o.id = ol.order_id WHERE pl.requisition_id = p.id AND o.status <> 'cancelled')
         ORDER BY p.urgent DESC, p.needed_by NULLS LAST LIMIT ${LIMIT}`.execute(this.db);
      for (const p of r.rows) out.push({ id: p.id, source: 'proc_pr_order', title: `PR ${p.pr_no} დამტკიცებულია — შეკვეთა (PO) არ არის`, detail: `${p.loc} · ~${money(p.est_total)}`,
        patient: null, department: p.dep, due_at: p.needed_by ? dayEndOf(p.needed_by) : null, due_date_only: !!p.needed_by, priority: p.urgent ? 'high' : 'normal',
        link: `/procurement/requisitions?id=${p.id}`, created_at: p.approved });
    }
    if (c.has('proc_po_approve') && has(u, 'procurement_approve')) {
      const r = await sql<{ id: string; po_no: string; total: string; currency: string; created_at: Date; updated_at: Date; sup: string; loc: string }>`
        SELECT o.id, o.po_no, o.total_net AS total, o.currency, o.created_at, o.updated_at, s.name AS sup, l.name AS loc
          FROM proc_orders o JOIN stock_suppliers s ON s.id = o.supplier_id JOIN stock_locations l ON l.id = o.location_id
         WHERE o.status = 'pending' AND o.created_by <> ${u.id} ORDER BY o.updated_at LIMIT ${LIMIT}`.execute(this.db);
      for (const o of r.rows) out.push({ id: o.id, source: 'proc_po_approve', title: `შეკვეთა ${o.po_no} — დასამტკიცებელი`, detail: `${o.sup} · ${Number(o.total).toFixed(2)} ${o.currency} · ${o.loc}`,
        patient: null, department: null, due_at: x.sla('proc_approve', o.updated_at), priority: 'normal', link: `/procurement/orders?id=${o.id}`, created_at: o.updated_at });
    }
    if (c.has('proc_po_overdue') && rules.po_mode !== 'off') {
      const staff = has(u, 'procurement') || (has(u, 'stock_manager') && !(await x.capExists('procurement')));
      const r = await sql<{ id: string; po_no: string; status: string; expected: string; sup: string; loc: string; sent_at: Date | null }>`
        SELECT o.id, o.po_no, o.status, to_char(o.expected_date, 'YYYY-MM-DD') AS expected, s.name AS sup, l.name AS loc, o.sent_at
          FROM proc_orders o JOIN stock_suppliers s ON s.id = o.supplier_id JOIN stock_locations l ON l.id = o.location_id
         WHERE o.status IN ('sent', 'partial') AND o.expected_date < ${TODAY} AND (o.created_by = ${u.id} OR ${staff})
         ORDER BY o.expected_date LIMIT ${LIMIT}`.execute(this.db);
      for (const o of r.rows) out.push({ id: o.id, source: 'proc_po_overdue', title: `შეკვეთა ${o.po_no} — მიწოდება აგვიანებს`, detail: `${o.sup} · ${o.loc}${o.status === 'partial' ? ' · ნაწილობრივ მიღებული' : ''}`,
        patient: null, department: null, due_at: dayEndOf(o.expected), due_date_only: true, priority: 'normal', link: `/procurement/orders?id=${o.id}`, created_at: o.sent_at });
    }
    return out;
  }

  /** მომწოდებლის ინვოისი: შეჯერება / გადახდის ვადა — ბუღალტერი */
  private async payables(u: AuthUser, c: Set<string>): Promise<Row[]> {
    if (!has(u, 'accountant')) return [];
    const rules = await procRules(this.db);
    const out: Row[] = [];
    type Inv = { id: string; ap_no: string | null; invoice_no: string; due: string | null; currency: string; sup: string; balance: string; diff: string | null; created_at: Date; status: string };
    const q = (where: ReturnType<typeof sql>) => sql<Inv>`
      SELECT i.id, i.ap_no, i.invoice_no, to_char(i.due_date, 'YYYY-MM-DD') AS due, i.currency, s.name AS sup, i.match_diff AS diff, i.created_at, i.status,
             (i.total - coalesce((SELECT sum(p.amount) FROM ap_payments p WHERE p.invoice_id = i.id AND NOT p.is_void), 0))::text AS balance
        FROM ap_invoices i JOIN stock_suppliers s ON s.id = i.supplier_id WHERE ${where} ORDER BY i.due_date NULLS LAST, i.created_at LIMIT ${LIMIT}`.execute(this.db);
    if (c.has('ap_match')) for (const i of (await q(sql`i.match_status = 'mismatch' AND i.status <> 'void'`)).rows)
      out.push({ id: i.id, source: 'ap_match', title: `ინვოისი ${i.invoice_no} — შეჯერება არ ემთხვევა`, detail: `${i.sup}${i.diff ? ` · სხვაობა ${money(i.diff)}` : ''} · გადახდა დაბლოკილია`,
        patient: null, department: null, due_at: null, priority: 'high', link: `/procurement/invoices?id=${i.id}`, created_at: i.created_at });
    if (c.has('ap_due')) for (const i of (await q(sql`i.status = 'posted' AND i.due_date <= ${TODAY} + ${rules.ap_due_days}::int`)).rows.filter((y) => Number(y.balance) > 0))
      out.push({ id: i.id, source: 'ap_due', title: `გადასახდელი: ${i.sup} — ${i.invoice_no}`, detail: `${i.ap_no ?? ''} · ნაშთი ${Number(i.balance).toFixed(2)} ${i.currency}`,
        patient: null, department: null, due_at: i.due ? dayEndOf(i.due) : null, due_date_only: true, priority: 'normal', link: `/procurement/invoices?id=${i.id}`, created_at: i.created_at });
    return out;
  }

  // ------------------------------------------------------------------ ფინანსები
  private async finance(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const acc = has(u, 'accountant');
    const out: Row[] = [];
    if (c.has('fin_claim_due') && acc) {
      const r = await sql<{ id: string; claim_no: string; due: string; payer: string; outstanding: string; sent_at: Date }>`
        SELECT c.id, c.claim_no, to_char(c.due_date, 'YYYY-MM-DD') AS due, p.name AS payer, (c.total_claimed - c.total_paid - c.total_resolved)::text AS outstanding, c.sent_at
          FROM fin_claims c JOIN payers p ON p.id = c.payer_id
         WHERE c.status IN ('sent', 'partial') AND c.due_date < ${TODAY} ORDER BY c.due_date LIMIT ${LIMIT}`.execute(this.db);
      for (const k of r.rows) out.push({ id: k.id, source: 'fin_claim_due', title: `ქლეიმი ${k.claim_no} — ანაზღაურება ვადაგადაცილებულია`, detail: `${k.payer} · დაუფარავი ${money(k.outstanding)}`,
        patient: null, department: null, due_at: dayEndOf(k.due), due_date_only: true, priority: 'high', link: `/finance/claims?id=${k.id}`, created_at: k.sent_at });
    }
    if (c.has('fin_claim_resolve') && has(u, 'accountant', 'billing')) {
      // H1: ხაზზე პასუხი rejected / partial, ან ქლეიმი ვადაგადაცილებულია — დაუფარავი, გადაუწყვეტელი ნაშთით (ქლეიმზე ერთი ჩანაწერი)
      const r = await sql<{ id: string; claim_no: string; payer: string; n: number; rej: number; amount: string; sent_at: Date }>`
        SELECT c.id, c.claim_no, p.name AS payer, count(*)::int AS n, count(*) FILTER (WHERE ci.resp_status IN ('rejected', 'partial'))::int AS rej,
               sum(ci.claimed - ci.paid - ci.resolved_amount)::text AS amount, c.sent_at
          FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id JOIN payers p ON p.id = c.payer_id
         WHERE ci.resolution IS NULL AND ci.claimed - ci.paid - ci.resolved_amount > 0 AND c.status IN ('sent', 'partial')
           AND (ci.resp_status IN ('rejected', 'partial') OR c.due_date < ${TODAY})
         GROUP BY c.id, c.claim_no, p.name, c.sent_at ORDER BY c.sent_at LIMIT ${LIMIT}`.execute(this.db);
      for (const k of r.rows) out.push({ id: k.id, source: 'fin_claim_resolve', title: `ქლეიმი ${k.claim_no} — ${k.n} ხაზი გადასაწყვეტია`,
        detail: `${k.payer} · ${money(k.amount)}${k.rej ? ` · უარი / ნაწილობრივი: ${k.rej}` : ''} — პაციენტზე / ჩამოწერა`, patient: null, department: null, due_at: null,
        priority: 'normal', link: `/finance/claims?id=${k.id}`, created_at: k.sent_at });
    }
    if (c.has('fin_claim_build') && acc) {
      const day = Number((await sql<{ d: number }>`SELECT extract(day FROM ${TODAY})::int AS d`.execute(this.db)).rows[0].d);
      if (day >= (x.s.claim_build_day ?? 5)) {
        const r = await sql<{ id: string; payer: string; n: number; amount: string; month: string }>`
          WITH m AS (SELECT (date_trunc('month', ${TODAY}) - interval '1 month')::date AS f, (date_trunc('month', ${TODAY}) - interval '1 day')::date AS t),
          cand AS (
            SELECT sp.payer_id, i.id AS invoice_id, sum(sp.covered_amount) AS amount
              FROM stay_payers sp JOIN inpatient_stays st ON st.encounter_id = sp.encounter_id JOIN invoices i ON i.encounter_id = st.encounter_id, m
             WHERE sp.status = 'active' AND sp.covered_amount > 0 AND st.status <> 'cancelled' AND i.finalized_at IS NOT NULL
               AND fin_local_date(i.finalized_at) BETWEEN m.f AND m.t
               AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id AND ci.payer_id = sp.payer_id)
             GROUP BY sp.payer_id, i.id
            UNION ALL
            SELECT y.payer_id, i.id, y.amount
              FROM invoices i JOIN encounters e ON e.id = i.encounter_id, m,
                   LATERAL (VALUES (i.insurance_payer_id, i.insurance_share), (i.state_payer_id, i.state_share)) AS y(payer_id, amount)
             WHERE y.payer_id IS NOT NULL AND y.amount > 0 AND e.status::text <> 'cancelled'
               AND NOT EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)
               AND fin_local_date(i.created_at) BETWEEN m.f AND m.t
               AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id AND ci.payer_id = y.payer_id))
          SELECT p.id, p.name AS payer, count(*)::int AS n, sum(cand.amount)::text AS amount, to_char((SELECT f FROM m), 'YYYY-MM') AS month
            FROM cand JOIN payers p ON p.id = cand.payer_id GROUP BY p.id, p.name ORDER BY p.name LIMIT ${LIMIT}`.execute(this.db);
        const due = await sql<{ d: Date }>`SELECT ((date_trunc('month', ${TODAY}) + interval '1 month')::date::timestamp AT TIME ZONE ${TZ}) - interval '1 second' AS d`.execute(this.db);
        for (const p of r.rows) out.push({ id: `${p.id}:${p.month}`, source: 'fin_claim_build', title: `ქლეიმის მომზადება: ${p.payer} · ${p.month}`, detail: `${p.n} შემთხვევა ქლეიმის გარეშე · ${money(p.amount)}`,
          patient: null, department: null, due_at: due.rows[0].d, priority: 'normal', link: `/finance/claims`, created_at: null });
      }
    }
    if (c.has('fin_period') && acc && (await finRules(this.db)).period_lock === 'on') {
      const r = await sql<{ month: string; status: string | null; due: Date }>`
        SELECT to_char(m.month, 'YYYY-MM') AS month, p.status,
               ((date_trunc('month', ${TODAY})::date + (${x.s.period_close_day ?? 10}::int - 1))::timestamp AT TIME ZONE ${TZ}) + interval '1 day' - interval '1 second' AS due
          FROM (SELECT (date_trunc('month', ${TODAY}) - interval '1 month')::date AS month) m LEFT JOIN fin_periods p ON p.month = m.month
         WHERE coalesce(p.status, 'open') = 'open'`.execute(this.db);
      for (const p of r.rows) out.push({ id: p.month, source: 'fin_period', title: `პერიოდის დახურვა: ${p.month}`, detail: 'წინა თვე ღიაა — შემოწმება და დახურვა (period_lock)',
        patient: null, department: null, due_at: p.due, due_date_only: true, priority: 'normal', link: '/finance/periods', created_at: null });
    }
    return out;
  }

  /** გაწერილი ჰოსპიტალიზაცია ფინალიზაციის გარეშე — ბილინგი; ვადა = გაწერა + ipd_finalize_days */
  private async billFinalize(u: AuthUser, x: AdminCtx): Promise<Row[]> {
    if (!has(u, 'billing')) return [];
    const days = x.s.ipd_finalize_days ?? 3;
    const r = await sql<{ id: string; adm_no: string; ended_at: Date; pat: string; dep: string | null; total: string }>`
      SELECT st.encounter_id AS id, st.adm_no, st.ended_at, p.last_name || ' ' || p.first_name AS pat, d.name AS dep, i.total_amount::text AS total
        FROM inpatient_stays st JOIN invoices i ON i.encounter_id = st.encounter_id JOIN patients p ON p.id = st.patient_id
        JOIN encounters e ON e.id = st.encounter_id LEFT JOIN departments d ON d.id = e.department_id
       WHERE st.status = 'discharged' AND i.finalized_at IS NULL ORDER BY st.ended_at LIMIT ${LIMIT}`.execute(this.db);
    return r.rows.map((s) => ({ id: s.id, source: 'bill_finalize', title: `ფინალიზაცია: ${s.adm_no}`, detail: `გაწერილია · ${money(s.total)}`, patient: s.pat, department: s.dep,
      due_at: days > 0 ? new Date(new Date(s.ended_at).getTime() + days * 864e5) : s.ended_at, priority: 'normal' as Priority, link: `/inpatient/stay/${s.id}#billing`, created_at: s.ended_at }));
  }

  /** ტარიფის / გადამხდელის წესის ცვლილება (approval = required) — tariffs_approve, ავტორის გარდა; ვადა — უახლოესი valid_from */
  private async tariffs(u: AuthUser): Promise<Row[]> {
    if (!has(u, 'tariffs_approve')) return [];
    const r = await sql<{ id: string; change_no: string; kind: string; title: string; created_at: Date; who: string; vf: string | null; n: number }>`
      SELECT c.id, c.change_no, c.kind, c.title, c.created_at, cu.last_name || ' ' || cu.first_name AS who,
             to_char(least((SELECT min(i.valid_from) FROM tariff_change_items i WHERE i.change_id = c.id),
                           (SELECT min(v.valid_from) FROM payer_rule_versions v WHERE v.change_id = c.id)), 'YYYY-MM-DD') AS vf,
             (SELECT count(*)::int FROM tariff_change_items i WHERE i.change_id = c.id) AS n
        FROM tariff_changes c JOIN users cu ON cu.id = c.created_by
       WHERE c.status = 'pending' AND c.approval = 'required' AND c.created_by <> ${u.id} ORDER BY c.created_at LIMIT ${LIMIT}`.execute(this.db);
    return r.rows.map((c) => ({ id: c.id, source: 'tariff_approve', title: `${c.kind === 'rules' ? 'გადამხდელის წესი' : 'ტარიფის ცვლილება'} ${c.change_no} — დასამტკიცებელი`,
      detail: `${c.title}${c.n ? ` · ${c.n} ჩანაწ.` : ''} · ${c.who}`, patient: null, department: null, due_at: c.vf ? dayEndOf(c.vf, -1) : null, due_date_only: !!c.vf,
      priority: 'normal' as Priority, link: `/admin/tariffs?tab=${c.kind === 'rules' ? 'rules' : 'changes'}`, created_at: c.created_at }));
  }

  // ------------------------------------------------------------------ CSSD
  private async cssd(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const out: Row[] = [];
    const [side, units] = await Promise.all([x.deptSide(), x.cssdUnits()]);
    if ((c.has('cssd_recall') || c.has('cssd_expiry')) && (side.size || units.size)) {
      const r = await sql<{ id: string; pack_no: string; status: string; exp: Date | null; expired: boolean; set_name: string; dep: string; issued_at: Date | null; unit: string; mine_dep: boolean }>`
        SELECT p.id, p.pack_no, p.status, ${dayEnd('p.expires_on')} AS exp, p.expires_on < ${TODAY} AS expired, t.name || ' #' || s.serial AS set_name, d.name AS dep, p.issued_at, l.name AS unit,
               p.issued_department_id = ANY (${uuids(side)}::uuid[]) AS mine_dep
          FROM cssd_packs p JOIN cssd_sets s ON s.id = p.set_id JOIN cssd_templates t ON t.id = s.template_id JOIN departments d ON d.id = p.issued_department_id JOIN stock_locations l ON l.id = p.location_id
         WHERE p.issued_department_id IS NOT NULL
           AND ((p.status = 'recalled' AND (p.issued_department_id = ANY (${uuids(side)}::uuid[]) OR p.location_id = ANY (${uuids(units)}::uuid[])))
             OR (p.status = 'issued' AND p.expires_on <= ${TODAY} + 7 AND p.issued_department_id = ANY (${uuids(side)}::uuid[])))
         ORDER BY p.status DESC, p.expires_on LIMIT ${LIMIT}`.execute(this.db);
      for (const p of r.rows) {
        if (p.status === 'recalled' && c.has('cssd_recall')) out.push({ id: p.id, source: 'cssd_recall', title: `გაწვეულია: ${p.pack_no} · ${p.set_name}`,
          detail: `${p.dep} → ${p.unit} — არ გამოიყენოთ, დააბრუნეთ CSSD-ში`, patient: null, department: p.dep, due_at: null, priority: 'urgent', link: '/cssd?tab=dept', created_at: p.issued_at });
        if (p.status === 'issued' && c.has('cssd_expiry')) out.push({ id: p.id, source: 'cssd_expiry', title: `სტერილობის ვადა${p.expired ? ' გავიდა' : ''}: ${p.pack_no} · ${p.set_name}`,
          detail: `${p.dep} — დააბრუნეთ CSSD-ში (ხელახალი დამუშავება)`, patient: null, department: p.dep, due_at: p.exp, due_date_only: true, priority: p.expired ? 'high' : 'normal',
          link: '/cssd?tab=dept', created_at: p.issued_at });
      }
    }
    if (units.size && c.has('cssd_bi')) {
      const h = x.s.bi_due_hours ?? 48;
      const r = await sql<{ id: string; cycle_no: string; machine: string; started_at: Date; packs: number; unit: string }>`
        SELECT y.id, y.cycle_no, m.name AS machine, y.started_at, l.name AS unit,
               (SELECT count(*)::int FROM cssd_packs p WHERE p.cycle_id = y.id AND p.status = 'quarantine') AS packs
          FROM cssd_cycles y JOIN cssd_machines m ON m.id = y.machine_id JOIN stock_locations l ON l.id = m.location_id
         WHERE y.bi_result = 'pending' AND m.location_id = ANY (${uuids(units)}::uuid[]) ORDER BY y.started_at LIMIT ${LIMIT}`.execute(this.db);
      for (const y of r.rows) out.push({ id: y.id, source: 'cssd_bi', title: `BI-ს პასუხი: ციკლი ${y.cycle_no} · ${y.machine}`, detail: `${y.unit} · კარანტინში: ${y.packs} შეფუთვა`,
        patient: null, department: null, due_at: new Date(new Date(y.started_at).getTime() + h * 3600_000), priority: y.packs ? 'high' : 'normal',
        link: `/cssd?tab=cycles&cycle=${y.id}`, created_at: y.started_at });
    }
    if (units.size && c.has('cssd_bd') && (await x.modSettings('cssd')).bd_required !== false) {
      const r = await sql<{ id: string; name: string; unit: string }>`
        SELECT m.id, m.name, l.name AS unit FROM cssd_machines m JOIN stock_locations l ON l.id = m.location_id
         WHERE m.is_active AND m.kind = 'steam' AND m.location_id = ANY (${uuids(units)}::uuid[])
           AND NOT EXISTS (SELECT 1 FROM cssd_cycles y WHERE y.machine_id = m.id AND y.kind = 'bowie_dick' AND y.result = 'pass'
                            AND (y.started_at AT TIME ZONE ${TZ})::date = ${TODAY})
         ORDER BY m.name LIMIT ${LIMIT}`.execute(this.db);
      for (const m of r.rows) out.push({ id: m.id, source: 'cssd_bd', title: `Bowie-Dick — ${m.name}`, detail: `${m.unit} · დღის პირველ ციკლამდე`,
        patient: null, department: null, due_at: null, priority: 'high', link: '/cssd?tab=cycles', created_at: null });
    }
    return out;
  }

  // ------------------------------------------------------------------ ინვენტარი
  private async assets(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const out: Row[] = [];
    if (c.has('asset_move')) {
      // canDecideMove (A1): მიმღები პასუხისმგებელი; არ არის — მიმღები განყოფილების ხელმძღვანელი; არც ის — stock_manager
      const [me, head, heads] = await Promise.all([x.me(), x.isHead(), x.heads()]);
      const mgr = has(u, 'stock_manager');
      const r = await sql<{ id: string; inv_no: string; name: string; to_dep_id: string | null; to_resp: string | null; to_dep: string | null; from_dep: string | null; requested_at: Date; who: string }>`
        SELECT m.id, a.inv_no, a.name, m.to_department_id AS to_dep_id, m.to_responsible_id AS to_resp, td.name AS to_dep, fd.name AS from_dep, m.requested_at,
               rq.last_name || ' ' || rq.first_name AS who
          FROM asset_moves m JOIN assets a ON a.id = m.asset_id JOIN users rq ON rq.id = m.requested_by
          LEFT JOIN departments td ON td.id = m.to_department_id LEFT JOIN departments fd ON fd.id = m.from_department_id
          LEFT JOIN users tr ON tr.id = m.to_responsible_id AND tr.is_active
         WHERE m.status = 'pending' AND (m.to_responsible_id = ${u.id}
            OR (tr.id IS NULL AND m.to_department_id IS NOT NULL AND m.to_department_id = ${me.department_id} AND ${head})
            OR (tr.id IS NULL AND ${mgr} AND (m.to_department_id IS NULL OR NOT (m.to_department_id = ANY (${uuids(heads)}::uuid[])))))
         ORDER BY m.requested_at LIMIT ${LIMIT}`.execute(this.db);
      for (const m of r.rows) out.push({ id: m.id, source: 'asset_move', title: `გადაადგილება: ${m.inv_no} ${m.name}`, detail: `${m.from_dep ?? '—'} → ${m.to_dep ?? '—'} · ${m.who}`,
        patient: null, department: m.to_dep, due_at: x.sla('asset_move', m.requested_at), priority: 'normal', link: '/assets?tab=incoming', created_at: m.requested_at });
    }
    if (c.has('asset_writeoff')) {
      const committee = ((await x.modSettings('asset_register')).writeoff_committee as string[] | undefined) ?? [];
      const member = committee.includes(u.id);
      const mgr = has(u, 'stock_manager');
      if (member || mgr) {
        const r = await sql<{ id: string; mode: string; reason: string; created_at: Date; n: number; votes: number; quorum: number; who: string }>`
          SELECT w.id, w.mode, w.reason, w.created_at, w.quorum, cu.last_name || ' ' || cu.first_name AS who,
                 (SELECT count(*)::int FROM asset_writeoff_lines l WHERE l.writeoff_id = w.id) AS n,
                 (SELECT count(*)::int FROM asset_writeoff_votes v WHERE v.writeoff_id = w.id AND v.approve) AS votes
            FROM asset_writeoffs w JOIN users cu ON cu.id = w.created_by
           WHERE w.status = 'pending'
             AND ((w.mode = 'committee' AND ${member} AND NOT EXISTS (SELECT 1 FROM asset_writeoff_votes v WHERE v.writeoff_id = w.id AND v.user_id = ${u.id}))
               OR (w.mode <> 'committee' AND ${mgr} AND w.created_by <> ${u.id}))
           ORDER BY w.created_at LIMIT ${LIMIT}`.execute(this.db);
        for (const w of r.rows) out.push({ id: w.id, source: 'asset_writeoff', title: `ჩამოწერის აქტი — ${w.mode === 'committee' ? 'კომისიის ხმა' : 'დასამტკიცებელი'}`,
          detail: `${w.n} ერთ. · ${w.reason}${w.mode === 'committee' ? ` · ხმა ${w.votes} / ${w.quorum}` : ''} · ${w.who}`, patient: null, department: null, due_at: null, priority: 'normal',
          link: '/assets?tab=writeoffs', created_at: w.created_at });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ რეგისტრატურა / სალარო
  private async reception(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const out: Row[] = [];
    const deps = await x.regDepts();
    const depCond = (col: string) => (deps === null ? sql`TRUE` : sql`${sql.ref(col)} = ANY (${uuids(deps)}::uuid[])`);
    if (c.has('reg_appt') && has(u, 'receptionist')) {
      const r = await sql<{ id: string; start: Date; end: Date; status: string; pat: string; doc: string; dep: string }>`
        SELECT a.id, a.scheduled_start AS start, a.scheduled_end AS "end", a.status::text AS status, p.last_name || ' ' || p.first_name AS pat,
               du.last_name || ' ' || du.first_name AS doc, d.name AS dep
          FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN users du ON du.id = a.doctor_id JOIN departments d ON d.id = a.department_id
         WHERE a.status IN ('scheduled', 'confirmed') AND a.scheduled_end < now()
           AND (a.scheduled_start AT TIME ZONE ${TZ})::date >= ${TODAY} - ${x.s.appt_open_days ?? 2}::int AND ${depCond('a.department_id')}
         ORDER BY a.scheduled_start LIMIT ${LIMIT}`.execute(this.db);
      const fmt = (d: Date) => new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
      for (const a of r.rows) out.push({ id: a.id, source: 'reg_appt', title: `ჩაწერა ${fmt(a.start)} — სტატუსი დაუხურავია`, detail: `${a.doc} · „მოვიდა“ / „არ გამოცხადდა“ / გაუქმება`,
        patient: a.pat, department: a.dep, due_at: a.end, priority: 'normal', link: '/reception', created_at: a.start });
    }
    if (c.has('cash_debt') && has(u, 'receptionist', 'billing')) {
      const r = await sql<{ id: string; created_at: Date; reason: string; pat: string; dep: string | null; share: string; paid: string; status: string }>`
        SELECT e.id, o.created_at, o.reason, p.last_name || ' ' || p.first_name AS pat, d.name AS dep, i.patient_share::text AS share, i.paid_status AS status,
               coalesce((SELECT sum(pm.amount) FROM payments pm WHERE pm.invoice_id = i.id), 0)::text AS paid
          FROM encounter_payment_overrides o JOIN encounters e ON e.id = o.encounter_id JOIN invoices i ON i.encounter_id = e.id JOIN patients p ON p.id = e.patient_id
          LEFT JOIN departments d ON d.id = e.department_id
         WHERE i.paid_status <> 'paid' AND i.patient_share > 0 AND e.status::text <> 'cancelled'
           AND NOT EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = e.id)
           AND o.created_at >= now() - make_interval(days => ${x.s.debt_days ?? 30}::int) AND ${depCond('e.department_id')}
         ORDER BY o.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const e of r.rows) {
        const due = Math.max(0, Number(e.share) - Number(e.paid));
        if (due <= 0) continue;
        out.push({ id: e.id, source: 'cash_debt', title: `ვალი: ${money(due)}`, detail: `გადახდის ნებართვით · ${e.reason}`, patient: e.pat, department: e.dep,
          due_at: new Date(new Date(e.created_at).getTime() + 3 * 864e5), priority: 'normal', link: `/cashier/${e.id}`, created_at: e.created_at });
      }
    }
    return out;
  }

  /** გეგმიური ჰოსპიტალიზაცია (დღეს / გადაცილებული, waiting) — რეგისტრატორი (reg_scope) + განყოფილების მხარე (dept_side) */
  private async planned(u: AuthUser, x: AdminCtx): Promise<Row[]> {
    if ((await x.modSettings('inpatient')).planned_queue === false) return [];
    const reg = has(u, 'receptionist') ? await x.regDepts() : undefined;
    const side = await x.deptSide();
    if (reg === undefined && !side.size) return [];
    const regCond = reg === undefined ? sql`FALSE` : reg === null ? sql`TRUE` : sql`q.department_id = ANY (${uuids(reg)}::uuid[])`;
    const r = await sql<{ id: string; plan_no: string; planned: string; pat: string; dep: string; doc: string | null; reason: string | null; bed: boolean; created_at: Date; late: boolean }>`
      SELECT q.id, q.plan_no, to_char(q.planned_date, 'YYYY-MM-DD') AS planned, p.last_name || ' ' || p.first_name AS pat, d.name AS dep,
             du.last_name || ' ' || du.first_name AS doc, coalesce(q.icd10_title, q.reason) AS reason, q.bed_id IS NOT NULL AS bed, q.created_at, q.planned_date < ${TODAY} AS late
        FROM inpatient_planned q JOIN patients p ON p.id = q.patient_id JOIN departments d ON d.id = q.department_id LEFT JOIN users du ON du.id = q.doctor_id
       WHERE q.status = 'waiting' AND q.planned_date <= ${TODAY} AND (${regCond} OR q.department_id = ANY (${uuids(side)}::uuid[]))
       ORDER BY q.planned_date, q.created_at LIMIT ${LIMIT}`.execute(this.db);
    return r.rows.map((q) => ({ id: q.id, source: 'reg_planned', title: `გეგმიური ჰოსპიტალიზაცია ${q.plan_no}${q.late ? ' (გადაცილებული)' : ' — დღეს'}`,
      detail: `${q.reason ?? ''}${q.doc ? ` · ${q.doc}` : ''}${q.bed ? ' · საწოლი დაჯავშნილია' : ''}`, patient: q.pat, department: q.dep,
      due_at: dayEndOf(q.planned), due_date_only: true, priority: q.late ? 'high' : 'normal' as Priority, link: '/inpatient?tab=planned', created_at: q.created_at }));
  }
}

/** YYYY-MM-DD → დღის ბოლო (23:59:59) კლინიკის დროით; shift — დღეების წანაცვლება */
function dayEndOf(day: string, shift = 0): Date {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(Date.parse(`${day}T23:59:59Z`) - mins * 60_000 + shift * 864e5);
}
