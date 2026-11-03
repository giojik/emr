/**
 * ლიცენზია ბრძანების ხაზიდან (0085).
 *
 * გამცემის მხარე (პირადი გასაღები — მხოლოდ გამცემთან, repo-ში / სერვერზე არასდროს):
 *   npm run license -- keygen --kid 2026-1 --out ~/emr-license/2026-1.key
 *       → პირადი გასაღები (0600) + ხაზი src/license/keys.ts-ის PROD_KEYS-ისთვის
 *   npm run license -- sign --key ~/emr-license/2026-1.key --kid 2026-1 --clinic "კლინიკა" --install-id <UUID> \
 *                           --modules all|outpatient,lab,... --expires 2027-12-31|never [--max-users 50] [--note "..."] --out license.json
 *
 * კლინიკის სერვერზე (DATABASE_URL):
 *   npm run license -- id                      ინსტალაციის ID (ლიცენზიის მოთხოვნისთვის)
 *   npm run license -- verify license.json     ფორმატი + ხელმოწერა + install_id (ბაზასთან, თუ ხელმისაწვდომია)
 *   npm run license -- install license.json    ატვირთვა (იგივე, რაც ადმინისტრირება → ლიცენზია)
 *   npm run license -- status
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../database/db';
import { PROD_KEYS, TEST_KEYS } from '../license/keys';
import { canonical, formatError, privateKeyFromPem, sha256, signLicense, timing, verifySignature, type LicenseFile, type LicensePayload } from '../license/license-core';
import { OPTIONAL_CODES } from '../modules/registry';

const die = (m: string): never => { console.error(`✘ ${m}`); process.exit(1); };
const testKeysAllowed = () => process.env.NODE_ENV !== 'production' && ['1', 'true'].includes(process.env.LICENSE_TEST_KEY ?? '');
const keys = () => ({ ...PROD_KEYS, ...(testKeysAllowed() ? TEST_KEYS : {}) });

function db() {
  if (!process.env.DATABASE_URL) die('DATABASE_URL არ არის მითითებული');
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) }) });
}
function readLicense(path: string | undefined): LicenseFile {
  if (!path) die('მიუთითეთ ფაილი');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path as string, 'utf8')); } catch (e) { die(`ფაილი ვერ წაიკითხა: ${(e as Error).message}`); }
  const err = formatError(raw);
  if (err) die(`ფორმატი: ${err}`);
  return raw as LicenseFile;
}
function summary(f: LicenseFile) {
  const p = f.payload;
  const t = timing(p.expires, Date.now(), process.env.CLINIC_TZ ?? 'Asia/Tbilisi');
  console.log(`  კლინიკა:     ${p.clinic}`);
  console.log(`  ინსტალაცია:  ${p.install_id}`);
  console.log(`  მოდულები:    ${p.modules.length} — ${p.modules.join(', ')}`);
  const unknown = p.modules.filter((m) => !OPTIONAL_CODES.includes(m));
  if (unknown.length) console.log(`  ! ამ ვერსიისთვის უცნობი (იგნორირდება): ${unknown.join(', ')}`);
  console.log(`  გაცემა:      ${p.issued}   ვადა: ${p.expires ?? 'უვადო'}${p.expires ? ` (${t.phase}, დარჩა ${t.days_left} დღე)` : ''}`);
  console.log(`  მომხმარებლები: ${p.max_users ?? 'ლიმიტის გარეშე'}   გასაღები: ${f.kid}`);
}

async function main() {
  try { process.loadEnvFile(); } catch { /* env გარედან */ }
  const [command, ...rest] = process.argv.slice(2);
  const { values: a, positionals } = parseArgs({
    args: rest, strict: true, allowPositionals: true,
    options: {
      kid: { type: 'string' }, out: { type: 'string' }, key: { type: 'string' }, clinic: { type: 'string' }, 'install-id': { type: 'string' },
      modules: { type: 'string' }, expires: { type: 'string' }, issued: { type: 'string' }, 'max-users': { type: 'string' }, note: { type: 'string' }, force: { type: 'boolean' },
    },
  });
  const need = (k: keyof typeof a) => { const v = a[k]; if (!v || typeof v !== 'string') die(`--${k} სავალდებულოა`); return v as string; };

  switch (command) {
    case 'keygen': {
      const kid = need('kid'); const out = need('out');
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(kid)) die('kid: ასოები / ციფრები / . _ - (≤ 40)');
      if (existsSync(out) && !a.force) die(`${out} უკვე არსებობს (--force — გადაწერა)`);
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      console.log(`✔ პირადი გასაღები: ${out} (0600) — შეინახეთ უსაფრთხოდ, repo-ში / სერვერზე არ განათავსოთ`);
      console.log('  src/license/keys.ts → PROD_KEYS:');
      console.log(`  '${kid}': '${pub}',`);
      break;
    }
    case 'sign': {
      const key = privateKeyFromPem(readFileSync(need('key'), 'utf8'));
      const mods = need('modules') === 'all' ? [...OPTIONAL_CODES] : need('modules').split(',').map((x) => x.trim()).filter(Boolean);
      const unknown = mods.filter((m) => !OPTIONAL_CODES.includes(m));
      if (unknown.length) console.warn(`! ამ ვერსიისთვის უცნობი მოდული(ები): ${unknown.join(', ')} — ძველი ვერსია მათ იგნორირებას გაუკეთებს`);
      const exp = need('expires');
      const payload: LicensePayload = {
        clinic: need('clinic'), install_id: need('install-id').toLowerCase(), modules: mods,
        issued: a.issued ?? new Date().toISOString().slice(0, 10), expires: exp === 'never' ? null : exp,
        ...(a['max-users'] ? { max_users: Number(a['max-users']) } : {}), ...(a.note ? { note: a.note } : {}),
      };
      const err = formatError({ v: 1, kid: need('kid'), payload, sig: 'x'.repeat(88) });
      if (err) die(err);
      const f = signLicense(payload, need('kid'), key);
      const out = need('out');
      writeFileSync(out, `${JSON.stringify(f, null, 2)}\n`);
      console.log(`✔ ${out}  (sha256 ${sha256(canonical(f)).slice(0, 16)}…)`);
      summary(f);
      break;
    }
    case 'verify': {
      const f = readLicense(positionals[0]);
      const v = verifySignature(f, keys());
      if (v !== 'ok') die(v === 'LICENSE_UNKNOWN_KEY' ? `გასაღები ${f.kid} ამ ვერსიისთვის უცნობია` : 'ხელმოწერა არასწორია');
      console.log('✔ ხელმოწერა სწორია'); summary(f);
      if (process.env.DATABASE_URL) {
        const d = db();
        const inst = await d.selectFrom('system_install').select('install_id').executeTakeFirst().catch(() => undefined);
        if (inst) console.log(inst.install_id.toLowerCase() === f.payload.install_id.toLowerCase() ? '✔ install_id ემთხვევა ამ სერვერს' : `✘ install_id არ ემთხვევა (სერვერი: ${inst.install_id})`);
        await d.destroy();
      }
      break;
    }
    case 'id': {
      const d = db();
      console.log((await d.selectFrom('system_install').select('install_id').executeTakeFirstOrThrow()).install_id);
      await d.destroy();
      break;
    }
    case 'status': {
      const d = db();
      const inst = await d.selectFrom('system_install').select('install_id').executeTakeFirstOrThrow();
      const cur = await d.selectFrom('system_licenses').selectAll().where('removed_at', 'is', null).orderBy('uploaded_at', 'desc').limit(1).executeTakeFirst();
      console.log(`ინსტალაცია: ${inst.install_id}`);
      if (!cur) console.log(process.env.NODE_ENV === 'production' ? 'ლიცენზია არ არის — მხოლოდ ბირთვი' : 'ლიცენზია არ არის — dev: ყველა მოდული');
      else summary(cur.raw as unknown as LicenseFile);
      await d.destroy();
      break;
    }
    case 'install': {
      const f = readLicense(positionals[0]);
      const v = verifySignature(f, keys());
      if (v !== 'ok') die(v === 'LICENSE_UNKNOWN_KEY' ? `გასაღები ${f.kid} ამ ვერსიისთვის უცნობია` : 'ხელმოწერა არასწორია');
      const d = db();
      const inst = await d.selectFrom('system_install').select('install_id').executeTakeFirstOrThrow();
      if (inst.install_id.toLowerCase() !== f.payload.install_id.toLowerCase()) { await d.destroy(); die(`install_id არ ემთხვევა (სერვერი: ${inst.install_id})`); }
      const p = f.payload;
      await d.transaction().execute(async (trx) => {
        const row = await trx.insertInto('system_licenses').values({ raw: JSON.stringify(f), sha256: sha256(canonical(f)), kid: f.kid, clinic: p.clinic.trim(), modules: p.modules,
          issued: p.issued, expires: p.expires, max_users: p.max_users ?? null, uploaded_by: null }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('audit_logs').values({ user_id: null, action: 'LICENSE_UPLOAD', entity_name: 'system_licenses', entity_id: row.id,
          new_data: JSON.stringify({ clinic: p.clinic, modules: p.modules, issued: p.issued, expires: p.expires, max_users: p.max_users ?? null, kid: f.kid, via: 'cli' }), user_agent: 'emr-cli' }).execute();
        await sql`SELECT pg_notify('emr_modules', 'license')`.execute(trx);
      });
      console.log('✔ ლიცენზია დაყენდა'); summary(f);
      await d.destroy();
      break;
    }
    default:
      console.log('ბრძანებები: keygen | sign | verify <ფაილი> | id | status | install <ფაილი>  (დეტალები — src/cli/license.ts)');
      process.exit(command ? 1 : 0);
  }
}
main().catch((e) => die((e as Error).message));
