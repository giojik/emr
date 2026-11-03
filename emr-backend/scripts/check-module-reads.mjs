#!/usr/bin/env node
// =====================================================================
// 0086 (A): აქტიურობის ერთი წყარო — lint (npm run build-ის წინ, prebuild).
//
// მოდულის ჩართულობა (`system_modules.enabled`) პირდაპირ იკითხება მხოლოდ src/modules/-ში (რეესტრი + ლიცენზია + წინაპირობები),
// config-package-ში (იმპორტი წერს enabled-ს), migrate-ში და cli-ში. სხვაგან — modActive / modUsable (src/modules/modules-ref.ts)
// ან ModulesService.isActive / isUsable / assertActive. პარამეტრების (settings) წაკითხვა დაშვებულია.
//
// დარღვევა → build ჩერდება (exit 1). გაშვება ხელით: node scripts/check-module-reads.mjs
// =====================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const ALLOW = ['modules/', 'config-package/', 'migrate.ts', 'cli/', 'database/db.d.ts'];

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
walk(SRC);

const bad = [];
for (const f of files) {
  const rel = relative(SRC, f).split(sep).join('/');
  if (ALLOW.some((a) => rel === a || rel.startsWith(a))) continue;
  // კომენტარები → ჰარები (ხაზების ნომრები რჩება)
  const txt = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
  // 1) system_modules + enabled ერთ გამოსახულებაში (შემდეგ `;`-მდე, მაქს. 600 სიმბოლო)
  for (const m of txt.matchAll(/system_modules/g)) {
    const end = txt.indexOf(';', m.index);
    const win = txt.slice(m.index, end < 0 ? m.index + 600 : Math.min(end, m.index + 600));
    if (/\benabled\b/.test(win)) bad.push(`${rel}:${txt.slice(0, m.index).split('\n').length}`);
  }
  // 2) ModulesService.get('x').enabled (ადმინის ჩამრთველი)
  for (const m of txt.matchAll(/modules\.get\([^)]*\)\)\s*\.enabled/g)) bad.push(`${rel}:${txt.slice(0, m.index).split('\n').length}`);
}

if (bad.length) {
  console.error('✗ მოდულის ჩართულობა პირდაპირ იკითხება (system_modules.enabled) — გამოიყენეთ modActive / modUsable (src/modules/modules-ref.ts):');
  for (const b of bad) console.error(`    ${b}`);
  process.exit(1);
}
console.log(`✔ check-module-reads: ${files.length} ფაილი — system_modules.enabled მხოლოდ დაშვებულ ადგილებში`);
