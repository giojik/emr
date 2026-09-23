import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Client, InvalidCredentialsError } from 'ldapts';
import { readFileSync } from 'node:fs';
import { loadEnv } from '../config/env';

/** LDAP-ში დასაშვები მომხმარებლის სახელი — injection-ის გამორიცხვა bind template-სა და ფილტრში */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** RFC 4515 — ფილტრის მნიშვნელობის escaping */
const escapeFilter = (v: string) => v.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));

export type LdapResult = 'ok' | 'invalid_credentials' | 'not_in_group';

@Injectable()
export class LdapService {
  private readonly log = new Logger('LDAP');
  private readonly env = loadEnv();
  private readonly ca = this.env.LDAP_TLS_CA_FILE ? [readFileSync(this.env.LDAP_TLS_CA_FILE)] : undefined;

  isValidUsername(u: string) { return USERNAME_RE.test(u); }

  /**
   * მომხმარებლის პაროლის შემოწმება დომენ-კონტროლერზე (bind მისივე სახელით).
   * სერვისის ანგარიში არ სჭირდება. DC მიუწვდომლობისას — 503 (არა "არასწორი პაროლი").
   */
  async authenticate(username: string, password: string): Promise<LdapResult> {
    // ⚠️ ცარიელი პაროლით bind LDAP-ში "anonymous bind"-ია და წარმატებით სრულდება!
    if (!password || !this.isValidUsername(username)) return 'invalid_credentials';

    const env = this.env;
    const client = new Client({
      url: env.LDAP_URL!,
      timeout: env.LDAP_TIMEOUT_MS,
      connectTimeout: env.LDAP_TIMEOUT_MS,
      // TLS პარამეტრები მხოლოდ ldaps://-ისთვის (ldap://-ზე ldapts-ი სხვაგვარად TLS-ს სცდის)
      tlsOptions: env.LDAP_URL!.startsWith('ldaps://')
        ? { ca: this.ca, rejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED }
        : undefined,
    });

    try {
      await client.bind(env.LDAP_BIND_TEMPLATE!.replaceAll('{username}', username), password);

      if (env.LDAP_REQUIRED_GROUP_DN) {
        const userFilter = env.LDAP_USER_FILTER.replaceAll('{username}', escapeFilter(username));
        const group = escapeFilter(env.LDAP_REQUIRED_GROUP_DN);
        const memberOf = env.LDAP_NESTED_GROUPS
          ? `(memberOf:1.2.840.113556.1.4.1941:=${group})`   // AD: ჩადგმული ჯგუფების ჩათვლით
          : `(memberOf=${group})`;
        const { searchEntries } = await client.search(env.LDAP_BASE_DN!, {
          scope: 'sub', filter: `(&${userFilter}${memberOf})`, attributes: ['dn'], sizeLimit: 1,
        });
        if (searchEntries.length === 0) return 'not_in_group';
      }
      return 'ok';
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return 'invalid_credentials';   // AD: არასწორი პაროლი / გათიშული / ვადაგასული
      this.log.error(`LDAP error: ${(e as Error).message}`);
      throw new ServiceUnavailableException('დომენის სერვერი მიუწვდომელია. სცადეთ მოგვიანებით ან მიმართეთ IT-ს.');
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}
