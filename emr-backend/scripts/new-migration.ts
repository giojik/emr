/** npm run migration:new -- add_patient_notes  →  migrations/0002_add_patient_notes.sql */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = (process.argv[2] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
if (!name) { console.error('გამოყენება: npm run migration:new -- <name>'); process.exit(1); }
const dir = join(process.cwd(), 'migrations');
const last = readdirSync(dir).map((f) => /^(\d{4})_/.exec(f)?.[1]).filter(Boolean).sort().pop() ?? '0000';
const next = String(Number(last) + 1).padStart(4, '0');
const file = join(dir, `${next}_${name}.sql`);
writeFileSync(file, `-- ${next}_${name}.sql\n-- წესი: მხოლოდ უკუთავსებადი ცვლილებები (ახალი სვეტი NULL/DEFAULT-ით, ახალი ცხრილი, ინდექსი).\n-- დიდ ცხრილზე ინდექსისთვის: პირველ ხაზად "-- migrate:no-transaction" + CREATE INDEX CONCURRENTLY (ფაილში მხოლოდ ერთი ბრძანება).\n\n`);
console.log(`შეიქმნა: ${file}`);
