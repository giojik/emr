import { Controller, Get, Global, HttpCode, Injectable, Logger, Module, Param, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { BELL_ALWAYS, BELL_SOURCE, SOURCES, enabledModules } from '../worklist/worklist-common';
import { modulesRef } from '../modules/modules-ref';
import { RequireModule } from '../modules/module-guard';
import { modActive } from '../modules/modules-ref';

/** თანამშრომლის შეტყობინებები (ზარი). ერთი (მომხმარებელი, ტიპი, ობიექტი) — ერთი წაუკითხავი ჩანაწერი, ელემენტები ერთიანდება */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');
  constructor(@InjectDb() private readonly db: Database) {}

  /** 0084 — ზარის ჩახშობის პარამეტრები (30 წმ კეში) */
  private sup: { t: number; v: { on: boolean; sources: Record<string, boolean>; ackAll: boolean } } | null = null;
  private async suppression() {
    if (this.sup && Date.now() - this.sup.t < 30_000) return this.sup.v;
    const m = await this.db.selectFrom('system_modules').select('settings').where('code', '=', 'worklist').executeTakeFirst();
    const st = (m?.settings ?? {}) as { bell_suppress?: string; sources?: Record<string, boolean>; ack_scope?: string };
    const v = { on: (await modActive(this.db, 'worklist')) && st.bell_suppress === 'non_urgent', sources: st.sources ?? {}, ackAll: st.ack_scope === 'all' };
    this.sup = { t: Date.now(), v };
    return v;
  }
  /** ჩაიხშოს თუ არა: ჩვეულებრივი შეტყობინება, რომლის წყარო „ჩემს დავალებებში“ ჩართულია (BELL_SOURCE); სასწრაფო / BELL_ALWAYS — არასდროს */
  async suppressed(kind: string, urgent: boolean) {
    if (urgent || BELL_ALWAYS.has(kind)) return false;
    const src = BELL_SOURCE[kind];
    if (!src) return false;
    const s = await this.suppression();
    if (!s.on || s.sources[src] === false) return false;
    // 0085: წყაროს მოდული არააქტიურია — სიაში არ ჩანს, ზარი არ იჩახშობა (worklist-ის აქტიურობაც)
    const svc = modulesRef.svc;
    if (svc && (!(await svc.isActive('worklist')) || (SOURCES[src] && !(await enabledModules(this.db)).has(SOURCES[src].module)))) return false;
    // „პასუხი მზადაა“ — res_ack მხოლოდ ack_scope = all-ზე ფარავს ყველა პასუხს
    if (src === 'res_ack' && !s.ackAll) return false;
    return true;
  }
  clearSuppressionCache() { this.sup = null; }

  async notify(userId: string, n: { kind: string; title: string; body?: string | null; link?: string | null; entityId?: string | null; item?: string | null; urgent?: boolean }) {
    try {
      const items = n.item ? [n.item] : [];
      if (await this.suppressed(n.kind, !!n.urgent)) {
        // „სიაში უკვე არის“ — იწერება წაკითხულად (ისტორიაში ჩანს, მთვლელს არ ზრდის)
        await this.db.insertInto('user_notifications').values({ user_id: userId, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, entity_id: n.entityId ?? null,
          items, urgent: false, suppressed: true, read_at: sql`now()` }).execute();
        return;
      }
      await this.db.insertInto('user_notifications').values({ user_id: userId, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, entity_id: n.entityId ?? null,
        items, urgent: !!n.urgent })
        .onConflict((oc) => oc.expression(sql`user_id, kind, entity_id`).where('read_at', 'is', null).doUpdateSet({
          title: sql`CASE WHEN user_notifications.urgent OR excluded.urgent THEN (CASE WHEN excluded.urgent THEN excluded.title ELSE user_notifications.title END) ELSE excluded.title END`,
          body: sql`excluded.body`, link: sql`excluded.link`,
          items: sql`(SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(user_notifications.items || excluded.items) x)`,
          urgent: sql`user_notifications.urgent OR excluded.urgent`, updated_at: sql`now()` }))
        .execute();
    } catch (e) { this.log.error(`შეტყობინება: ${(e as Error).message}`); }
  }
  list(userId: string, unread: boolean) {
    let q = this.db.selectFrom('user_notifications').select(['id', 'kind', 'title', 'body', 'link', 'items', 'urgent', 'suppressed', 'created_at', 'updated_at', 'read_at'])
      .where('user_id', '=', userId).orderBy('read_at', 'desc').orderBy('updated_at', 'desc').limit(50);
    if (unread) q = q.where('read_at', 'is', null);
    else q = q.where((eb) => eb.or([eb('read_at', 'is', null), eb('updated_at', '>', sql<Date>`now() - interval '14 days'`)]));
    return q.execute();
  }
  async count(userId: string) {
    const r = await this.db.selectFrom('user_notifications').select([sql<number>`count(*)`.as('n'), sql<number>`count(*) FILTER (WHERE urgent)`.as('urgent')])
      .where('user_id', '=', userId).where('read_at', 'is', null).executeTakeFirst();
    return { unread: Number(r?.n ?? 0), urgent: Number(r?.urgent ?? 0) };
  }
  async read(userId: string, id?: string) {
    let q = this.db.updateTable('user_notifications').set({ read_at: sql`now()` }).where('user_id', '=', userId).where('read_at', 'is', null);
    if (id) q = q.where('id', '=', id);
    await q.execute();
    return this.count(userId);
  }
}

/** ყველა ავტორიზებულისთვის — მხოლოდ საკუთარი შეტყობინებები */
@Controller('notifications')
@RequireModule('core')
export class NotificationsController {
  constructor(private readonly n: NotificationsService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query('unread') unread?: string) { return this.n.list(u.id, unread === 'true'); }
  @Get('count') count(@CurrentUser() u: AuthUser) { return this.n.count(u.id); }
  @Post('read-all') @HttpCode(200) readAll(@CurrentUser() u: AuthUser) { return this.n.read(u.id); }
  @Post(':id/read') @HttpCode(200) read(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.n.read(u.id, String(Number(id) || 0)); }
}

@Global()
@Module({ providers: [NotificationsService], controllers: [NotificationsController], exports: [NotificationsService] })
export class NotificationsModule {}
