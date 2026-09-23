/**
 * მომხმარებლების მართვა ბრძანების ხაზიდან (პირველი admin, "break-glass" აღდგენა).
 *
 *   npm run user -- create --email a@b.ge --first-name გიორგი --last-name ჯიქია \
 *                          --personal-number 01001012345 --role admin [--provider local]
 *   npm run user -- create ... --provider ldap --ldap-username giojik
 *   npm run user -- reset-password --email a@b.ge     (ახალი დროებითი პაროლი + სესიების გაუქმება)
 *   npm run user -- unlock --email a@b.ge
 *   npm run user -- disable --email a@b.ge
 *
 * დროებითი პაროლი იბეჭდება ერთხელ; პირველი შესვლისას სისტემა მის შეცვლას მოითხოვს.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { PasswordService } from '../auth/password.service';
import { ROLES, type Role } from '../auth/roles';
import type { DB } from '../database/db';

async function main() {
  try { process.loadEnvFile(); } catch { /* env გარედან */ }
  const [command, ...rest] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: rest, strict: true,
    options: {
      email: { type: 'string' }, 'first-name': { type: 'string' }, 'last-name': { type: 'string' },
      'personal-number': { type: 'string' }, role: { type: 'string' }, provider: { type: 'string', default: 'local' },
      'ldap-username': { type: 'string' }, specialty: { type: 'string' },
    },
  });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL არ არის მითითებული');
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) }) });
  const pw = new PasswordService();
  const audit = (action: string, entityId: string, newData?: unknown) =>
    db.insertInto('audit_logs').values({ user_id: null, action, entity_name: 'users', entity_id: entityId,
      new_data: newData ? JSON.stringify(newData) : null, user_agent: 'emr-cli' }).execute();
  const need = (k: keyof typeof a) => { const v = a[k]; if (!v) throw new Error(`--${k} სავალდებულოა`); return v as string; };
  const findByEmail = async () => {
    const u = await db.selectFrom('users').select(['id', 'auth_provider']).where('email', '=', need('email').toLowerCase()).executeTakeFirst();
    if (!u) throw new Error('მომხმარებელი ვერ მოიძებნა');
    return u;
  };

  try {
    switch (command) {
      case 'create': {
        const role = need('role') as Role;
        if (!ROLES.includes(role)) throw new Error(`--role: ${ROLES.join(', ')}`);
        const provider = a.provider as 'local' | 'ldap';
        if (provider !== 'local' && provider !== 'ldap') throw new Error('--provider: local ან ldap');
        const temp = provider === 'local' ? PasswordService.generateTemporary() : null;

        const user = await db.insertInto('users').values({
          email: need('email').toLowerCase(), first_name: need('first-name'), last_name: need('last-name'),
          personal_number: need('personal-number'), role, specialty: a.specialty ?? null,
          auth_provider: provider,
          ldap_username: provider === 'ldap' ? need('ldap-username').toLowerCase() : null,
          password_hash: temp ? await pw.hash(temp) : null,
          must_change_password: provider === 'local',
        }).returning(['id', 'email']).executeTakeFirstOrThrow();
        await audit('USER_CREATED', user.id, { email: user.email, role, provider });

        console.log(`✔ შეიქმნა: ${user.email} (${role}, ${provider})`);
        if (temp) console.log(`  დროებითი პაროლი: ${temp}\n  (ნაჩვენებია მხოლოდ ერთხელ — პირველი შესვლისას შეცვლა სავალდებულოა)`);
        else console.log(`  შესვლა: დომენის სახელით "${a['ldap-username']}" და Windows პაროლით`);
        break;
      }
      case 'reset-password': {
        const u = await findByEmail();
        if (u.auth_provider !== 'local') throw new Error('დომენის ანგარიშის პაროლი AD-ში იცვლება');
        const temp = PasswordService.generateTemporary();
        await db.transaction().execute(async (trx) => {
          await trx.updateTable('users').set({ password_hash: await pw.hash(temp), must_change_password: true,
            failed_login_count: 0, locked_until: null }).where('id', '=', u.id).execute();
          await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: 'password_reset' })
            .where('user_id', '=', u.id).where('revoked_at', 'is', null).execute();
        });
        await audit('PASSWORD_RESET', u.id);
        console.log(`✔ ახალი დროებითი პაროლი: ${temp}`);
        break;
      }
      case 'unlock': {
        const u = await findByEmail();
        await db.updateTable('users').set({ failed_login_count: 0, locked_until: null }).where('id', '=', u.id).execute();
        await audit('USER_UNLOCKED', u.id);
        console.log('✔ განბლოკილია');
        break;
      }
      case 'disable': {
        const u = await findByEmail();
        await db.transaction().execute(async (trx) => {
          await trx.updateTable('users').set({ is_active: false }).where('id', '=', u.id).execute();
          await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: 'user_disabled' })
            .where('user_id', '=', u.id).where('revoked_at', 'is', null).execute();
        });
        await audit('USER_DISABLED', u.id);
        console.log('✔ გათიშულია, ყველა სესია გაუქმდა');
        break;
      }
      default:
        console.log('ბრძანებები: create | reset-password | unlock | disable   (დეტალები: src/cli/users.ts)');
        process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  const msg = (e as { code?: string }).code === '23505' ? 'ასეთი email / პირადი ნომერი / დომენის სახელი უკვე არსებობს' : (e as Error).message;
  console.error('✘', msg);
  process.exit(1);
});
