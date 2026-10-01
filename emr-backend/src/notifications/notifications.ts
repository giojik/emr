import { Controller, Get, Global, HttpCode, Injectable, Logger, Module, Param, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';

/** თანამშრომლის შეტყობინებები (ზარი). ერთი (მომხმარებელი, ტიპი, ობიექტი) — ერთი წაუკითხავი ჩანაწერი, ელემენტები ერთიანდება */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');
  constructor(@InjectDb() private readonly db: Database) {}

  async notify(userId: string, n: { kind: string; title: string; body?: string | null; link?: string | null; entityId?: string | null; item?: string | null; urgent?: boolean }) {
    try {
      const items = n.item ? [n.item] : [];
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
    let q = this.db.selectFrom('user_notifications').select(['id', 'kind', 'title', 'body', 'link', 'items', 'urgent', 'created_at', 'updated_at', 'read_at'])
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
