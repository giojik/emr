import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { stockRules } from './stock-rules';

const TZ = loadEnv().CLINIC_TZ;

/**
 * ყოველდღიური შემოწმება (emr-worker, კლინიკის დროით `alert_hour`-ის შემდეგ, დღეში ერთხელ):
 *   ვადაგასული / ვადაგასვლადი ლოტები და მინიმუმზე ქვემოთ საქონელი — შეტყობინება ლოკაციის პასუხისმგებლებს.
 * პასუხისმგებლები: განყოფილების ქვესაწყობი — განყოფილების ხელმძღვანელი / მენეჯერი (თუ არ ჰყავს — საწყობის მენეჯერი);
 *   სხვა ლოკაცია — მესაწყობე + საწყობის მენეჯერი (აფთიაქი — + ფარმაცევტი).
 */
@Injectable()
export class StockAlertsService {
  private readonly log = new Logger('StockAlerts');
  constructor(@InjectDb() private readonly db: Database, private readonly notifications: NotificationsService) {}

  private async now() {
    const r = await sql<{ d: string; h: number }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d, extract(hour FROM now() AT TIME ZONE ${TZ})::int AS h`.execute(this.db);
    return r.rows[0];
  }

  async recipients(l: { kind: string; department_id: string | null }) {
    const withCaps = async (caps: string[], dep?: string, heads = false) => {
      let x = this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').where('u.is_active', '=', true)
        .where(sql<boolean>`c.capabilities && ${sql.val(caps)}::varchar[]`);
      if (dep) x = x.where('u.department_id', '=', dep);
      if (heads) x = x.where((eb) => eb.or([eb('u.is_section_head', '=', true), eb(sql<boolean>`'manager' = ANY(c.capabilities)`, '=', true)]));
      return (await x.execute()).map((r) => r.id);
    };
    if (l.kind === 'lab') return withCaps(['lab_manager', 'lab_doctor']);
    if (l.kind === 'department' && l.department_id) {
      const heads = await withCaps(['nurse', 'doctor', 'manager', 'admin', 'lab_manager', 'diagnostic'], l.department_id, true);
      return heads.length ? heads : withCaps(['stock_manager']);
    }
    return withCaps(l.kind === 'pharmacy' ? ['storekeeper', 'stock_manager', 'pharmacist'] : ['storekeeper', 'stock_manager']);
  }

  /** ვადები: ლოკაციაზე ერთი შეტყობინება (ვადაგასული — სასწრაფო) */
  async expiry(today: string) {
    const rows = await this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
      .innerJoin('stock_categories as c', 'c.id', 'i.category_id').innerJoin('stock_locations as l', 'l.id', 'b.location_id')
      .select(['l.id', 'l.name', 'l.kind', 'l.department_id',
        sql<number>`count(*) FILTER (WHERE lt.expires_on < ${today}::date)::int`.as('expired'),
        sql<number>`count(*) FILTER (WHERE lt.expires_on >= ${today}::date AND lt.expires_on <= ${today}::date + coalesce(i.expiry_warn_days, c.expiry_warn_days, 90))::int`.as('soon'),
        sql<number>`min(coalesce(i.expiry_warn_days, c.expiry_warn_days, 90))::int`.as('warn')])
      .where('b.qty', '>', '0').where('lt.expires_on', 'is not', null).where('l.is_active', '=', true).where('l.kind', '<>', 'transit')
      .groupBy(['l.id', 'l.name', 'l.kind', 'l.department_id']).execute();
    let sent = 0;
    for (const r of rows.filter((x) => x.expired > 0 || x.soon > 0)) {
      const ids = await this.recipients(r);
      const parts = [r.expired ? `ვადაგასული: ${r.expired} ლოტი` : '', r.soon ? `ვადა იწურება: ${r.soon} ლოტი` : ''].filter(Boolean).join('; ');
      for (const id of new Set(ids)) {
        await this.notifications.notify(id, { kind: 'stock_expiry', title: `ვადები — ${r.name}`, body: parts, urgent: r.expired > 0, entityId: r.id,
          link: `/stock/balances?location_id=${r.id}&expiring_days=${r.expired ? -1 : r.warn}` });
        sent++;
      }
    }
    return { locations: rows.filter((x) => x.expired > 0 || x.soon > 0).length, sent };
  }

  /** მინიმუმზე ქვემოთ (ნაშთი + გზაში + გაუცემელი მოთხოვნა < მინ.) */
  async minmax() {
    const below = await this.belowMin();
    const byLoc = new Map<string, typeof below>();
    for (const b of below) byLoc.set(b.location_id, [...(byLoc.get(b.location_id) ?? []), b]);
    let sent = 0;
    for (const [locId, items] of byLoc) {
      const l = items[0];
      const ids = await this.recipients({ kind: l.location_kind, department_id: l.department_id });
      for (const id of new Set(ids)) {
        await this.notifications.notify(id, { kind: 'stock_min', title: `მინიმუმზე ქვემოთ — ${l.location_name}`, body: items.slice(0, 5).map((x) => x.item_name).join(', ') + (items.length > 5 ? ` და კიდევ ${items.length - 5}` : ''),
          entityId: locId, link: `/stock/minmax?location_id=${locId}` });
        sent++;
      }
    }
    return { locations: byLoc.size, items: below.length, sent };
  }

  /** მინ/მაქს: მიმდინარე მდგომარეობა (გამოიყენება API-შიც) */
  async belowMin(locationId?: string, all = false) {
    const today = (await this.now()).d;
    let x = this.db.selectFrom('stock_minmax as m').innerJoin('stock_items as i', 'i.id', 'm.item_id').innerJoin('stock_locations as l', 'l.id', 'm.location_id')
      .innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['m.location_id', 'm.item_id', 'm.min_qty', 'm.max_qty', 'm.updated_at', 'i.name as item_name', 'i.code as item_code', 'i.is_active as item_active', 'un.name as base_unit_name',
        'l.name as location_name', 'l.kind as location_kind', 'l.department_id', 'l.default_source_id',
        sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id WHERE b.location_id = m.location_id AND b.item_id = m.item_id
          AND lt.status = 'active' AND (lt.expires_on IS NULL OR lt.expires_on >= ${today}::date)), 0)`.as('on_hand'),
        sql<string>`coalesce((SELECT sum(x.qty_base) FROM stock_docs d JOIN stock_doc_lines x ON x.doc_id = d.id WHERE d.to_location_id = m.location_id AND x.item_id = m.item_id
          AND d.status = 'posted' AND d.receive_status IS NULL AND d.doc_type IN ('transfer', 'return')), 0)`.as('in_transit'),
        sql<string>`coalesce((SELECT sum(coalesce(rl.qty_approved, rl.qty_base) - rl.qty_issued) FROM stock_requests r JOIN stock_request_lines rl ON rl.request_id = r.id
          WHERE r.to_location_id = m.location_id AND rl.item_id = m.item_id AND r.status IN ('draft', 'submitted', 'approved', 'partial')), 0)`.as('requested')])
      .where('l.is_active', '=', true).orderBy('l.name').orderBy('i.name');
    if (locationId) x = x.where('m.location_id', '=', locationId);
    const rows = (await x.execute()).map((r) => {
      const have = Number(r.on_hand) + Number(r.in_transit) + Math.max(0, Number(r.requested));
      const below = r.item_active && have < Number(r.min_qty);
      return { ...r, below, suggested: below ? Math.max(0, Math.round((Number(r.max_qty) - have) * 1000) / 1000) : 0 };
    });
    return all ? rows : rows.filter((r) => r.below);
  }

  /** ლაბორატორია: გახსნილი რეაგენტის on-board ვადა იწურება (≤ 1 დღე) ან გასულია (0036) */
  async labOnboard() {
    const rows = await this.db.selectFrom('stock_lab_kits as k').innerJoin('stock_items as i', 'i.id', 'k.item_id').innerJoin('stock_locations as l', 'l.id', 'k.location_id')
      .leftJoin('lab_methods as m', 'm.id', 'k.method_id')
      .select(['k.location_id', 'l.name as location_name', 'i.name as item_name', 'm.name as method_name',
        sql<number>`k.onboard_expires_on - (now() AT TIME ZONE ${TZ})::date`.as('days_left')])
      .where('k.status', '=', 'in_use').where('k.onboard_expires_on', '<=', sql<string>`(now() AT TIME ZONE ${TZ})::date + 1`).execute();
    if (!rows.length) return { kits: 0, sent: 0 };
    const ids = await this.recipients({ kind: 'lab', department_id: null });
    const byLoc = new Map<string, typeof rows>();
    for (const r of rows) byLoc.set(r.location_id, [...(byLoc.get(r.location_id) ?? []), r]);
    let sent = 0;
    for (const [loc, ks] of byLoc) {
      for (const id of new Set(ids)) {
        await this.notifications.notify(id, { kind: 'lab_onboard', title: `გახსნილი რეაგენტი — on-board ვადა (${ks[0].location_name})`,
          body: ks.slice(0, 5).map((k) => `${k.item_name}${k.method_name ? ` · ${k.method_name}` : ''}${k.days_left < 0 ? ' (გასულია)' : ''}`).join(', '),
          urgent: ks.some((k) => k.days_left < 0), entityId: loc, link: '/stock/lab' });
        sent++;
      }
    }
    return { kits: rows.length, sent };
  }

  /** CSSD (0039): შენახვაში ვადაგასული სტერილური შეფუთვა → „ვადაგასული“ (ხელახალი დამუშავება); ერთეულის თანამშრომლებს — შეტყობინება */
  async cssdExpiry() {
    const mod = await this.db.selectFrom('system_modules').select('enabled').where('code', '=', 'cssd').executeTakeFirst();
    if (!mod?.enabled) return { skipped: true };
    const expired = await this.db.updateTable('cssd_packs').set({ status: 'expired' }).where('status', '=', 'sterile')
      .where('expires_on', '<', sql<string>`(now() AT TIME ZONE ${TZ})::date`).returning(['id', 'set_id', 'location_id']).execute();
    for (const p of expired) await this.db.updateTable('cssd_sets').set({ status: 'received' }).where('id', '=', p.set_id).where('status', '=', 'packed').execute();
    const soon = await this.db.selectFrom('cssd_packs').select(['location_id', sql<number>`count(*)::int`.as('n')]).where('status', 'in', ['sterile', 'issued'])
      .where('expires_on', '<=', sql<string>`(now() AT TIME ZONE ${TZ})::date + 7`).groupBy('location_id').execute();
    const locs = new Map<string, { exp: number; soon: number }>();
    for (const p of expired) locs.set(p.location_id, { exp: (locs.get(p.location_id)?.exp ?? 0) + 1, soon: locs.get(p.location_id)?.soon ?? 0 });
    for (const x of soon) locs.set(x.location_id, { exp: locs.get(x.location_id)?.exp ?? 0, soon: x.n });
    let sent = 0;
    for (const [id, v] of locs) {
      const l = await this.db.selectFrom('stock_locations').select(['name', 'department_id']).where('id', '=', id).executeTakeFirst();
      if (!l?.department_id) continue;
      const staff = (await this.db.selectFrom('users').select('id').where('department_id', '=', l.department_id).where('is_active', '=', true).execute()).map((x) => x.id);
      for (const uid of staff) {
        await this.notifications.notify(uid, { kind: 'cssd_expiry', title: `CSSD — სტერილობის ვადა (${l.name})`, body: [v.exp ? `ვადაგასული: ${v.exp} (ხელახალი დამუშავება)` : '', v.soon ? `≤ 7 დღე: ${v.soon}` : ''].filter(Boolean).join('; '),
          urgent: v.exp > 0, entityId: id, link: '/cssd?tab=storage' });
        sent++;
      }
    }
    return { expired: expired.length, sent };
  }

  /** worker: ყოველ 5 წუთში; `alert_hour`-ის შემდეგ — დღეში ერთხელ */
  async tick(force = false) {
    const { d, h } = await this.now();
    const st = await this.db.selectFrom('stock_settings').select('alert_hour').where('id', '=', 1).executeTakeFirstOrThrow();
    if (!force && h < st.alert_hour) return null;
    const out: Record<string, unknown> = {};
    const rules = await stockRules(this.db);
    for (const kind of ['expiry', 'minmax', 'lab', 'cssd'] as const) {
      if (kind !== 'cssd' && !rules[`alert_${kind}`]) continue;                     // შემადგენლობა — კლინიკის პარამეტრი (0038)
      if (!force) {
        const ins = await this.db.insertInto('stock_alert_runs').values({ kind, run_date: d }).onConflict((oc) => oc.columns(['kind', 'run_date']).doNothing()).returning('kind').executeTakeFirst();
        if (!ins) continue;                                     // დღეს უკვე შესრულდა
      }
      const stats = kind === 'expiry' ? await this.expiry(d) : kind === 'minmax' ? await this.minmax() : kind === 'lab' ? await this.labOnboard() : await this.cssdExpiry();
      out[kind] = stats;
      await this.db.insertInto('stock_alert_runs').values({ kind, run_date: d, stats: JSON.stringify(stats) })
        .onConflict((oc) => oc.columns(['kind', 'run_date']).doUpdateSet({ stats: JSON.stringify(stats), created_at: sql`now()` })).execute();
      this.log.log(`${kind}: ${JSON.stringify(stats)}`);
    }
    return out;
  }
}
