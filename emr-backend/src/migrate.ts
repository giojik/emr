/**
 * EMR migration runner — სუფთა SQL, forward-only.
 *
 *   node dist/migrate.js                  გამოუყენებელი migration-ების გაშვება
 *   node dist/migrate.js --dry-run        მხოლოდ სია: რა გაეშვება
 *   node dist/migrate.js --baseline 0001  მონიშნავს 0001-მდე ყველას, როგორც გამოყენებულს
 *                                         (არსებული ბაზისთვის, რომელშიც schema უკვე ჩატვირთულია)
 *
 * წესები:
 *  - ფაილი: migrations/NNNN_აღწერა.sql
 *  - თითოეული migration ცალკე ტრანზაქციაშია. თუ ფაილის პირველ ხაზზე წერია
 *    `-- migrate:no-transaction`, ტრანზაქციის გარეშე ეშვება (მაგ. CREATE INDEX CONCURRENTLY).
 *    ასეთ ფაილში მხოლოდ ერთი SQL ბრძანება უნდა იყოს (PostgreSQL მრავალ-ბრძანებიან
 *    query-ს იმპლიციტურ ტრანზაქციად ასრულებს).
 *  - უკვე გამოყენებული ფაილის შეცვლა აღმოჩნდება checksum-ით და runner გაჩერდება.
 *  - pg_advisory_lock იცავს ერთდროული გაშვებისგან (ორი კონტეინერი / ორი ადმინი).
 *  - Down migration-ები არ არის: ცვლილებები უკუთავსებადი უნდა იყოს (expand → contract).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const LOCK_KEY = 72_000_001; // ნებისმიერი უნიკალური რიცხვი ამ აპლიკაციისთვის
const MIGRATIONS_DIR = resolve(process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'migrations'));
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

interface MigrationFile { version: string; name: string; file: string; sql: string; checksum: string; noTransaction: boolean }

function loadFiles(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.map((file) => {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`არასწორი ფაილის სახელი: ${file} (მოსალოდნელია NNNN_name.sql)`);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    return {
      version: m[1], name: m[2], file, sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      noTransaction: /^\s*--\s*migrate:no-transaction/.test(sql),
    };
  });
}

async function main() {
  try { process.loadEnvFile(); } catch { /* .env არ არის — env ცვლადები გარედან */ }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL არ არის მითითებული');

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const baselineIdx = args.indexOf('--baseline');
  const baseline = baselineIdx >= 0 ? args[baselineIdx + 1] : undefined;
  if (baselineIdx >= 0 && !/^\d{4}$/.test(baseline ?? '')) throw new Error('--baseline მოითხოვს ვერსიას, მაგ: --baseline 0001');

  const files = loadFiles();
  const versions = new Set<string>();
  for (const f of files) {
    if (versions.has(f.version)) throw new Error(`დუბლირებული ვერსია: ${f.version}`);
    versions.add(f.version);
  }

  const client = new Client({ connectionString: url, application_name: 'emr-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version       VARCHAR(4) PRIMARY KEY,
        name          TEXT NOT NULL,
        checksum      CHAR(64) NOT NULL,
        applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        execution_ms  INT NOT NULL,
        baselined     BOOLEAN NOT NULL DEFAULT FALSE
      )`);
    // აპლიკაციის როლს migration-ების ჟურნალის მხოლოდ წაკითხვა შეუძლია (health check-ისთვის)
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
        REVOKE ALL ON schema_migrations FROM emr_app;
        GRANT SELECT ON schema_migrations TO emr_app;
      END IF; END $$;`);

    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    // 1) გამოყენებული ფაილები არ უნდა იყოს შეცვლილი
    for (const f of files) {
      const prev = applied.get(f.version);
      if (prev && prev !== f.checksum) {
        throw new Error(`${f.file} შეიცვალა გამოყენების შემდეგ (checksum mismatch). ცვლილება ახალი migration-ით შეიტანეთ.`);
      }
    }
    for (const v of applied.keys()) {
      if (!versions.has(v)) console.warn(`⚠️  ბაზაში გამოყენებულია ${v}, მაგრამ ფაილი აღარ არსებობს`);
    }

    const pending = files.filter((f) => !applied.has(f.version));
    if (pending.length === 0) { console.log('✔ ბაზა განახლებულია — ახალი migration არ არის'); return; }

    // 2) baseline რეჟიმი
    if (baseline) {
      const toMark = pending.filter((f) => f.version <= baseline);
      for (const f of toMark) {
        if (!dryRun) await client.query(
          'INSERT INTO schema_migrations(version, name, checksum, execution_ms, baselined) VALUES ($1,$2,$3,0,TRUE)',
          [f.version, f.name, f.checksum]);
        console.log(`${dryRun ? '[dry-run] ' : ''}⊙ baseline: ${f.file}`);
      }
      return;
    }

    // 3) ჩვეულებრივი გაშვება
    for (const f of pending) {
      if (dryRun) { console.log(`[dry-run] → ${f.file}${f.noTransaction ? ' (no-transaction)' : ''}`); continue; }
      const t0 = Date.now();
      process.stdout.write(`→ ${f.file} ... `);
      try {
        if (!f.noTransaction) await client.query('BEGIN');
        // production-ზე ცხრილის ხანგრძლივი დაბლოკვის თავიდან ასაცილებლად
        await client.query(`SET lock_timeout = '${process.env.MIGRATION_LOCK_TIMEOUT ?? '10s'}'`);
        await client.query(f.sql);
        await client.query(
          'INSERT INTO schema_migrations(version, name, checksum, execution_ms) VALUES ($1,$2,$3,$4)',
          [f.version, f.name, f.checksum, Date.now() - t0]);
        if (!f.noTransaction) await client.query('COMMIT');
        console.log(`ok (${Date.now() - t0} ms)`);
      } catch (err) {
        if (!f.noTransaction) await client.query('ROLLBACK').catch(() => undefined);
        console.log('FAILED');
        throw err;
      }
    }
    console.log(dryRun ? `ℹ გაეშვება ${pending.length} migration` : `✔ გამოყენებულია ${pending.length} migration`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

main().catch((err) => {
  console.error('✘ migration შეცდომა:', err instanceof Error ? err.message : err);
  process.exit(1);
});
