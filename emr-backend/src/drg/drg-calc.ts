import { BadRequestException, ConflictException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../database/db';
import { group, type GroupInputs, type GroupResult } from './drg-engine';
import { defaultSchemeId, drgRules, type DrgRules, gatherInputs, type InputDetails, inputsHash, loadVersion, stayInfo, type StayInfo, versionAt, versionDate, versionMeta,
  type VersionMeta } from './drg-data';

type Ex = Kysely<DB> | Transaction<DB>;

/**
 * DRG შემთხვევაზე (0055) — საერთო ფუნქციები: ბილინგის ჩანართი, დადასტურება, ფინალიზაციის შემოწმება, გადამხდელის ფორმა.
 * DI-ს გარეშე (ipd-billing იყენებს პირდაპირ).
 */
export interface StayEval {
  scheme: { id: string; code: string; name: string };
  version: VersionMeta | null;            // მოქმედი (ან მოთხოვნილი) ვერსია
  version_date: string;
  inputs: GroupInputs | null;
  details: InputDetails | null;
  hash: string | null;
  result: GroupResult | null;
  current: CurrentDrg | null;             // დადასტურებული (მიმდინარე) ჩანაწერი
  stale: boolean;                         // დადასტურების შემდეგ შეიცვალა მონაცემები ან ვერსია
  stale_reason: string | null;
}
export interface CurrentDrg {
  id: string; version_id: string; status: string; final_code: string; final_weight: string; suggested_code: string | null; reason: string | null; inputs_hash: string;
  confirmed_at: Date; confirmed_by_name: string; title: string | null;
}

export async function schemeOf(ex: Ex, payerId: string): Promise<string | null> {
  const p = await ex.selectFrom('payers').select('drg_scheme_id').where('id', '=', payerId).executeTakeFirst();
  return p?.drg_scheme_id ?? await defaultSchemeId(ex);
}

export async function currentDrg(ex: Ex, eid: string, schemeId: string): Promise<CurrentDrg | null> {
  return (await ex.selectFrom('stay_drg as d').innerJoin('users as u', 'u.id', 'd.confirmed_by')
    .leftJoin('drg_version_groups as g', (j) => j.onRef('g.version_id', '=', 'd.version_id').onRef('g.code', '=', 'd.final_code'))
    .select(['d.id', 'd.version_id', 'd.status', 'd.final_code', 'd.final_weight', 'd.suggested_code', 'd.reason', 'd.inputs_hash', 'd.confirmed_at', 'g.title',
      sql<string>`u.first_name || ' ' || u.last_name`.as('confirmed_by_name')])
    .where('d.encounter_id', '=', eid).where('d.scheme_id', '=', schemeId).where('d.superseded_at', 'is', null).executeTakeFirst()) ?? null;
}

/** შემთხვევის შეფასება სქემით: მოქმედი ვერსია (ან versionId — მაგ. მონახაზის შემოწმება), მონაცემები, შედეგი, დადასტურება, „შეიცვალა“ */
export async function evaluateStay(ex: Ex, eid: string, schemeId: string, opts: { versionId?: string; rules?: DrgRules; st?: StayInfo } = {}): Promise<StayEval> {
  const st = opts.st ?? await stayInfo(ex, eid);
  if (!st) throw new BadRequestException('ჰოსპიტალიზაცია ვერ მოიძებნა');
  const rules = opts.rules ?? await drgRules(ex);
  const sch = await ex.selectFrom('drg_schemes').select(['id', 'code', 'name']).where('id', '=', schemeId).executeTakeFirst();
  if (!sch) throw new BadRequestException('DRG სქემა ვერ მოიძებნა');
  const vdate = versionDate(st, rules);
  const vid = opts.versionId ?? await versionAt(ex, schemeId, vdate);
  const current = await currentDrg(ex, eid, schemeId);
  const out: StayEval = { scheme: sch, version: null, version_date: vdate, inputs: null, details: null, hash: null, result: null, current, stale: false, stale_reason: null };
  if (!vid) return out;
  const meta = await versionMeta(ex, vid);
  if (!meta || meta.scheme_id !== schemeId) throw new BadRequestException('ვერსია ამ სქემას არ ეკუთვნის');
  const v = await loadVersion(ex, vid);
  const { inputs, details } = await gatherInputs(ex, st, v.settings);
  out.version = meta; out.inputs = inputs; out.details = details; out.hash = inputsHash(inputs); out.result = group(inputs, v);
  if (current && !opts.versionId) {
    if (current.version_id !== vid) { out.stale = true; out.stale_reason = 'მოქმედი ვერსია შეიცვალა (თარიღი / ახალი ვერსია)'; }
    else if (current.inputs_hash !== out.hash) { out.stale = true; out.stale_reason = 'დადასტურების შემდეგ შეიცვალა მონაცემები (დიაგნოზი, ოპერაცია, დღეები, გაწერა …)'; }
  }
  return out;
}

/** DRG რეჟიმის აქტიური გადამხდელები და მათი სქემები */
export async function drgPayers(ex: Ex, eid: string) {
  const def = await defaultSchemeId(ex);
  const rows = await ex.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id')
    .select(['sp.id', 'sp.payer_id', 'p.name as payer_name', 'sp.drg_code', 'sp.drg_weight', 'sp.drg_base_rate', 'sp.drg_source', 'sp.drg_version_id', 'sp.stay_drg_id', 'p.drg_scheme_id'])
    .where('sp.encounter_id', '=', eid).where('sp.status', '=', 'active').where('sp.mode', '=', 'drg').orderBy('sp.seq').execute();
  return rows.map((r) => ({ ...r, scheme_id: r.drg_scheme_id ?? def }));
}

/**
 * ფინალიზაციის შემოწმება (ipd-billing → finalize): DRG გადამხდელზე, რომლის სქემას მოქმედი ვერსია აქვს —
 *   confirm_required: დადასტურება სავალდებულო, გადამხდელის კოდი = დადასტურებული;
 *   recheck_on_finalize: block — 409 DRG_STALE; warn — გაფრთხილება პასუხში.
 * მოდული გამორთულია ან ვერსია არ არის → არაფერი (0046-ის ხელით არჩევა).
 */
export async function drgFinalizeCheck(trx: Ex, eid: string): Promise<string[]> {
  const rules = await drgRules(trx);
  if (!rules.enabled) return [];
  const payers = await drgPayers(trx, eid);
  const warnings: string[] = [];
  const st = await stayInfo(trx, eid);
  for (const sid of [...new Set(payers.map((p) => p.scheme_id).filter((x): x is string => !!x))]) {
    const ev = await evaluateStay(trx, eid, sid, { rules, st });
    if (!ev.version) continue;
    const who = payers.filter((p) => p.scheme_id === sid);
    if (!ev.current) {
      if (rules.confirm_required) throw new ConflictException({ code: 'DRG_NOT_CONFIRMED', message: `DRG (${ev.scheme.name}) დადასტურებული არ არის — ბილინგი → DRG: დაადასტურეთ ან შეცვალეთ ჯგუფი` });
      continue;
    }
    const mism = who.filter((p) => p.drg_code !== ev.current!.final_code);
    if (mism.length && rules.confirm_required) {
      throw new ConflictException({ code: 'DRG_MISMATCH', message: `გადამხდელის DRG (${mism.map((p) => `${p.payer_name}: ${p.drg_code}`).join(', ')}) არ ემთხვევა დადასტურებულს (${ev.current.final_code})` });
    }
    if (ev.stale && rules.recheck_on_finalize !== 'off') {
      const msg = `DRG (${ev.scheme.name}): ${ev.stale_reason}${ev.result?.code && ev.result.code !== ev.current.final_code ? ` — ახალი შეთავაზება ${ev.result.code}, დადასტურებულია ${ev.current.final_code}` : ''}`;
      if (rules.recheck_on_finalize === 'block') throw new ConflictException({ code: 'DRG_STALE', message: `${msg}. დაადასტურეთ ხელახლა` });
      warnings.push(msg);
    }
  }
  return warnings;
}

/**
 * გადამხდელის ფორმა (ipd-billing → payerTerms): DRG რეჟიმი, მოქმედი ვერსია არის →
 *   კოდი არ არის მითითებული → დადასტურებული, თუ არა — შეთავაზება; წონა — ვერსიიდან;
 *   manual_payer_drg = grouper_only → ხელით სხვა კოდი დაუშვებელია (მხოლოდ დადასტურებული / შეთავაზება).
 * null → ვერსია არ არის / მოდული გამორთულია (ძველი ლოგიკა: drg_groups).
 */
export async function drgForPayer(ex: Ex, eid: string, payerId: string, code: string | null):
  Promise<{ code: string; weight: string; version_id: string; source: 'manual' | 'grouper'; stay_drg_id: string | null } | null> {
  const rules = await drgRules(ex);
  if (!rules.enabled) return null;
  const sid = await schemeOf(ex, payerId);
  if (!sid) return null;
  const ev = await evaluateStay(ex, eid, sid, { rules });
  if (!ev.version) return null;
  const auto = ev.current?.final_code ?? ev.result?.code ?? null;   // დადასტურებული, თუ არა — შეთავაზება
  const want = (code ?? '').toUpperCase() || auto;
  if (!want) throw new BadRequestException('DRG: ჯგუფი ვერ განისაზღვრა (ძირითადი დიაგნოზი / წესი) — მიუთითეთ კოდი ან შეავსეთ მონაცემები');
  if (rules.manual_payer_drg === 'grouper_only' && want !== auto) {
    throw new BadRequestException(`DRG კოდი ხელით არ ირჩევა (grouper_only) — გამოიყენეთ DRG ბლოკი (შეცვლა მიზეზით). მიმდინარე: ${auto ?? '—'}`);
  }
  const g = await ex.selectFrom('drg_version_groups').select(['code', 'title', 'weight']).where('version_id', '=', ev.version.id).where('code', '=', want).executeTakeFirst();
  if (!g) throw new BadRequestException(`DRG ${want} მოქმედ ვერსიაში (${ev.version.label}) არ არის`);
  await mirrorGroup(ex, g);
  const fromCurrent = ev.current && ev.current.final_code === want;
  return { code: want, weight: String(g.weight), version_id: ev.version.id, source: want === auto ? 'grouper' : 'manual', stay_drg_id: fromCurrent ? ev.current!.id : null };
}

/** drg_groups (0046-ის ცნობარი; stay_payers.drg_code FK) — კოდი უნდა არსებობდეს; არსებულს არ ვცვლით */
export async function mirrorGroup(ex: Ex, g: { code: string; title: string; weight: string | number }) {
  await ex.insertInto('drg_groups').values({ code: g.code, title: g.title, relative_weight: String(g.weight), is_active: true })
    .onConflict((oc) => oc.column('code').doUpdateSet({ is_active: true })).execute();
}
