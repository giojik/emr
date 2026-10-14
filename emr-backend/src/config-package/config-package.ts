import { BadRequestException, Controller, Get, HttpCode, Injectable, Module, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { memoryStorage } from 'multer';
import { createHash } from 'node:crypto';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser, Role } from '../auth/roles';
import { validateExport, validateResponse } from '../claims-export/claim-template';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { DrgConfigService, type Pkg } from '../drg/drg-config';
import { DrgModule } from '../drg/drg.module';
import { type Cond, condsText, normPattern, parseConds, PATTERN_RE, stableJson, validateCond } from '../drg/drg-engine';
import { VALIDATORS } from '../modules/modules';
import { BUILTIN_PARAMS, CUSTOM_FORBIDDEN } from '../scrub/scrub-engine';

const TZ = loadEnv().CLINIC_TZ;
export const PARTS = ['modules', 'drg', 'scrub_rules', 'claim_templates', 'denial_reasons', 'payers'] as const;
type Part = (typeof PARTS)[number];
export const PART_KA: Record<Part, string> = {
  modules: 'მოდულების პარამეტრები (DRG, შემოწმება)', drg: 'DRG სქემები და ვერსიები', scrub_rules: 'შემოწმების წესები', claim_templates: 'ფაილის შაბლონები',
  denial_reasons: 'უარის მიზეზები', payers: 'გადამხდელის მიბმა (სქემა, შაბლონები)',
};
const MODULES = ['drg', 'scrubber'] as const;
const EXPORT_ROLES: Role[] = ['admin', 'drg_admin', 'accountant'];

interface ConfigPackage {
  format: 'emr-config'; format_version: 1; exported_at: string; source?: string | null;
  parts: {
    modules?: { code: string; enabled: boolean; settings: Record<string, unknown> }[];
    drg?: { schemes: { code: string; name: string; notes: string | null; is_default: boolean }[]; versions: { scheme_code: string; status: string; package: Pkg }[] };
    scrub_rules?: { code: string; builtin: boolean; title: string; message: string | null; severity: string; is_active: boolean; payer_kinds: string[]; payer_codes: string[];
      params: Record<string, unknown>; conditions_text: string | null; allow_override: boolean }[];
    claim_templates?: { code: string; name: string; kind: string; format: string; config: unknown; notes: string | null; is_active: boolean }[];
    denial_reasons?: { code: string; title: string; category: string; external_codes: string[]; default_action: string | null; is_active: boolean; sort_order: number; scrub_rules: string[] }[];
    payers?: { code: string; name: string; drg_scheme_code: string | null; export_template_code: string | null; response_template_code: string | null }[];
  };
}
export interface PlanLine { part: Part; key: string; action: 'create' | 'update' | 'unchanged' | 'skip' | 'error'; detail?: string }

/** DRG ვერსიის შიგთავსი შედარებისთვის (მეტამონაცემების გარეშე) */
const drgBody = (p: Pkg) => stableJson({ settings: p.settings ?? {}, groups: p.groups, lists: p.lists, cc: p.cc,
  rules: p.rules.map((r) => ({ ...r, conditions: r.conditions ?? null, conditions_text: undefined })), components: (p.components ?? []).map((c) => ({ ...c, conditions_text: undefined })) });

/**
 * 0059: კონფიგურაციის პაკეტი — ერთი JSON: DRG სქემები / ვერსიები, შემოწმების წესები, ფაილის შაბლონები, უარის მიზეზები, მოდულების პარამეტრები, გადამხდელის მიბმა.
 *  გადატანა (სატესტო → სამუშაო), სარეზერვო ასლი. იმპორტი: ჯერ გეგმა (რა შეიქმნება / შეიცვლება / უცვლელია / შეცდომა), შემდეგ ჩაწერა.
 *  DRG ვერსია იქმნება მონახაზად (გააქტიურება — ცალკე, ჩვეულებრივი წესით); იდენტური შიგთავსი უკვე თუ არის — გამოტოვდება.
 *  გადამხდელი / წესი მიიბმება კოდით (id გარემოებს შორის განსხვავდება).
 */
@Injectable()
export class ConfigPackageService {
  constructor(@InjectDb() private readonly db: Database, private readonly drg: DrgConfigService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- ექსპორტი
  async export(parts: Part[], versionIds: string[] | null, ctx: AuditContext): Promise<ConfigPackage> {
    const out: ConfigPackage = { format: 'emr-config', format_version: 1, exported_at: new Date().toISOString(), parts: {} };
    out.source = (await this.db.selectFrom('clinic_settings').select('name').executeTakeFirst())?.name ?? null;
    const payerCode = new Map((await this.db.selectFrom('payers').select(['id', 'code']).execute()).map((p) => [p.id, p.code]));
    if (parts.includes('modules')) {
      out.parts.modules = (await this.db.selectFrom('system_modules').select(['code', 'enabled', 'settings']).where('code', 'in', [...MODULES]).orderBy('code').execute())
        .map((m) => ({ code: m.code, enabled: m.enabled, settings: (m.settings ?? {}) as Record<string, unknown> }));
    }
    if (parts.includes('drg')) {
      const schemes = await this.db.selectFrom('drg_schemes').select(['id', 'code', 'name', 'notes', 'is_default', 'is_active']).where('is_active', '=', true).orderBy('code').execute();
      let ids = versionIds;
      if (!ids?.length) {
        // ნაგულისხმევად: თითო სქემის დღეს მოქმედი ვერსია
        ids = [];
        for (const s of schemes) {
          const v = (await sql<{ id: string | null }>`SELECT drg_version_at(${s.id}::uuid, (now() AT TIME ZONE ${TZ})::date) AS id`.execute(this.db)).rows[0]?.id;
          if (v) ids.push(v);
        }
      }
      const vs = ids.length ? await this.db.selectFrom('drg_versions as v').innerJoin('drg_schemes as s', 's.id', 'v.scheme_id').select(['v.id', 'v.status', 's.code', 's.id as scheme_id'])
        .where('v.id', 'in', ids).execute() : [];
      if (vs.length !== ids.length) throw new BadRequestException('DRG ვერსია ვერ მოიძებნა');
      const versions = [];
      for (const v of vs) {
        const p = await this.drg.exportPackage(v.id);
        const { scheme_code: _s, exported_at: _e, ...pkg } = p;
        versions.push({ scheme_code: v.code, status: v.status, package: pkg as Pkg });
      }
      const used = new Set(vs.map((v) => v.scheme_id));
      out.parts.drg = { schemes: schemes.filter((s) => used.has(s.id) || s.is_default).map((s) => ({ code: s.code, name: s.name, notes: s.notes, is_default: s.is_default })), versions };
    }
    if (parts.includes('scrub_rules')) {
      out.parts.scrub_rules = (await this.db.selectFrom('scrub_rules').selectAll().orderBy('sort_order').orderBy('code').execute()).map((r) => ({
        code: r.code, builtin: r.builtin, title: r.title, message: r.message, severity: r.severity, is_active: r.is_active, payer_kinds: r.payer_kinds,
        payer_codes: r.payer_ids.map((id) => payerCode.get(id)).filter((x): x is string => !!x), params: (r.params ?? {}) as Record<string, unknown>,
        conditions_text: r.builtin ? null : condsText(r.conditions as unknown as Cond[]), allow_override: r.allow_override }));
    }
    if (parts.includes('claim_templates')) {
      out.parts.claim_templates = await this.db.selectFrom('claim_templates').select(['code', 'name', 'kind', 'format', 'config', 'notes', 'is_active']).orderBy('kind').orderBy('code').execute();
    }
    if (parts.includes('denial_reasons')) {
      out.parts.denial_reasons = await this.db.selectFrom('denial_reasons').select(['code', 'title', 'category', 'external_codes', 'default_action', 'is_active', 'sort_order', 'scrub_rules'])
        .orderBy('sort_order').orderBy('code').execute();
    }
    if (parts.includes('payers')) {
      out.parts.payers = await this.db.selectFrom('payers as p').leftJoin('drg_schemes as s', 's.id', 'p.drg_scheme_id').leftJoin('claim_templates as e', 'e.id', 'p.export_template_id')
        .leftJoin('claim_templates as r', 'r.id', 'p.response_template_id')
        .select(['p.code', 'p.name', 's.code as drg_scheme_code', 'e.code as export_template_code', 'r.code as response_template_code']).where('p.is_active', '=', true).orderBy('p.code').execute();
    }
    await this.audit.log(ctx, { action: 'CONFIG_PACKAGE_EXPORT', entityName: 'config_package', entityId: 'export',
      newData: { parts, drg_versions: out.parts.drg?.versions.length ?? 0 } });
    return out;
  }

  // ---------------------------------------------------------------- იმპორტი: გეგმა
  private parse(buf: Buffer): ConfigPackage {
    let p: ConfigPackage;
    try { p = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')) as ConfigPackage; } catch { throw new BadRequestException('ფაილი არ არის JSON'); }
    if (p?.format !== 'emr-config' || p.format_version !== 1 || !p.parts || typeof p.parts !== 'object') throw new BadRequestException('ფაილი არ არის კონფიგურაციის პაკეტი (format: emr-config, format_version: 1)');
    return p;
  }

  async plan(p: ConfigPackage, only: Part[], u: AuthUser, ctx: AuditContext) {
    const lines: PlanLine[] = [];
    const add = (l: PlanLine) => lines.push(l);
    const has = (k: Part) => only.includes(k) && p.parts[k] !== undefined;
    const arr = <T>(k: Part, x: unknown): T[] => { if (!Array.isArray(x)) { add({ part: k, key: '—', action: 'error', detail: 'სია არ არის' }); return []; } return x as T[]; };

    // მოდულები
    if (has('modules')) for (const m of arr<{ code: string; enabled: boolean; settings: Record<string, unknown> }>('modules', p.parts.modules)) {
      if (!(MODULES as readonly string[]).includes(m.code)) { add({ part: 'modules', key: String(m.code), action: 'skip', detail: 'მოდული პაკეტში არ განიხილება' }); continue; }
      const cur = await this.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', m.code).executeTakeFirst();
      const v = VALIDATORS[m.code];
      const bad = Object.entries(m.settings ?? {}).find(([k, val]) => !v?.keys[k] || !v.keys[k](val));
      if (bad) { add({ part: 'modules', key: m.code, action: 'error', detail: `პარამეტრი ${bad[0]}` }); continue; }
      const next = { ...((cur?.settings ?? {}) as object), ...(m.settings ?? {}) };
      const same = cur && cur.enabled === !!m.enabled && stableJson(cur.settings) === stableJson(next);
      add({ part: 'modules', key: m.code, action: same ? 'unchanged' : 'update', detail: same ? undefined : `${m.enabled ? 'ჩართული' : 'გამორთული'}; ${Object.entries(m.settings ?? {}).map(([k, x]) => `${k}=${String(x)}`).join(', ')}` });
    }

    // DRG
    if (has('drg')) {
      const d = p.parts.drg!;
      for (const s of arr<{ code: string; name: string }>('drg', d?.schemes ?? [])) {
        if (!/^[A-Z0-9][A-Z0-9_.-]{1,19}$/.test(String(s.code)) || String(s.name ?? '').trim().length < 2) { add({ part: 'drg', key: `სქემა ${s.code}`, action: 'error', detail: 'კოდი / დასახელება' }); continue; }
        const cur = await this.db.selectFrom('drg_schemes').select(['name', 'is_active']).where('code', '=', s.code).executeTakeFirst();
        add({ part: 'drg', key: `სქემა ${s.code}`, action: cur ? 'unchanged' : 'create', detail: cur ? (cur.is_active ? undefined : 'გათიშულია — ვერსია არ ჩაიწერება') : s.name });
      }
      for (const v of arr<{ scheme_code: string; package: Pkg }>('drg', d?.versions ?? [])) {
        const key = `${v.scheme_code}: ${v.package?.label ?? '—'} (${v.package?.valid_from ?? '—'})`;
        const sch = await this.db.selectFrom('drg_schemes').select(['id', 'is_active']).where('code', '=', v.scheme_code).executeTakeFirst();
        const inPkg = (d?.schemes ?? []).some((s) => s.code === v.scheme_code);
        if (!sch && !inPkg) { add({ part: 'drg', key, action: 'error', detail: `სქემა ${v.scheme_code} არ არსებობს და პაკეტში არ არის` }); continue; }
        if (sch && !sch.is_active) { add({ part: 'drg', key, action: 'error', detail: 'სქემა გათიშულია' }); continue; }
        try { await this.drg.importPackage(sch?.id ?? '00000000-0000-0000-0000-000000000000', { package: v.package as unknown as Record<string, unknown> }, u, ctx, 'DRG_VERSION_IMPORT', true); }
        catch (e) { add({ part: 'drg', key, action: 'error', detail: (e as Error).message }); continue; }
        // იგივე შიგთავსი უკვე არის?
        let dup: string | null = null;
        if (sch) for (const x of await this.db.selectFrom('drg_versions').select(['id', 'version_no', 'label']).where('scheme_id', '=', sch.id).execute()) {
          if (drgBody(await this.drg.exportPackage(x.id) as Pkg) === drgBody(v.package)) { dup = `v${x.version_no} ${x.label}`; break; }
        }
        add({ part: 'drg', key, action: dup ? 'unchanged' : 'create', detail: dup ? `იგივე შიგთავსი: ${dup}` : `ახალი მონახაზი — ${v.package.groups.length} ჯგუფი, ${v.package.rules.length} წესი` });
      }
    }

    // შემოწმების წესები
    const payers = new Map((await this.db.selectFrom('payers').select(['id', 'code']).execute()).map((x) => [x.code, x.id]));
    if (has('scrub_rules')) for (const r of arr<NonNullable<ConfigPackage['parts']['scrub_rules']>[number]>('scrub_rules', p.parts.scrub_rules)) {
      const key = String(r.code);
      const e = this.ruleError(r, payers);
      if (e) { add({ part: 'scrub_rules', key, action: 'error', detail: e }); continue; }
      const cur = await this.db.selectFrom('scrub_rules').selectAll().where('code', '=', r.code).executeTakeFirst();
      if (!cur && r.builtin) { add({ part: 'scrub_rules', key, action: 'error', detail: 'მზა წესი ამ ვერსიაში არ არსებობს' }); continue; }
      if (cur && cur.builtin !== !!r.builtin) { add({ part: 'scrub_rules', key, action: 'error', detail: 'მზა / საკუთარი — შეუსაბამობა' }); continue; }
      if (!cur) { add({ part: 'scrub_rules', key, action: 'create', detail: r.title }); continue; }
      const diff = this.ruleDiff(cur, r, payers);
      add({ part: 'scrub_rules', key, action: diff.length ? 'update' : 'unchanged', detail: diff.join(', ') || undefined });
    }

    // შაბლონები
    if (has('claim_templates')) for (const t of arr<NonNullable<ConfigPackage['parts']['claim_templates']>[number]>('claim_templates', p.parts.claim_templates)) {
      const key = String(t.code);
      if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(key) || !['export', 'response'].includes(t.kind) || !['xlsx', 'csv', 'xml'].includes(t.format) || String(t.name ?? '').trim().length < 2
        || (t.kind === 'response' && t.format === 'xml')) { add({ part: 'claim_templates', key, action: 'error', detail: 'კოდი / ტიპი / ფორმატი / დასახელება' }); continue; }
      const v = t.kind === 'export' ? validateExport(t.config, t.format) : validateResponse(t.config);
      if (v.errors.length) { add({ part: 'claim_templates', key, action: 'error', detail: v.errors[0] }); continue; }
      const cur = await this.db.selectFrom('claim_templates').selectAll().where('code', '=', key).executeTakeFirst();
      if (!cur) { add({ part: 'claim_templates', key, action: 'create', detail: t.name }); continue; }
      if (cur.kind !== t.kind) { add({ part: 'claim_templates', key, action: 'error', detail: 'ტიპი განსხვავდება' }); continue; }
      const prev = cur.kind === 'export' ? validateExport(cur.config, cur.format).cfg : validateResponse(cur.config).cfg;
      const cfgChanged = stableJson(prev) !== stableJson(v.cfg) || cur.format !== t.format;
      const other = cur.name !== t.name.trim() || cur.is_active !== (t.is_active !== false) || (cur.notes ?? null) !== (t.notes ?? null);
      add({ part: 'claim_templates', key, action: cfgChanged || other ? 'update' : 'unchanged', detail: cfgChanged ? `კონფიგურაცია (v${cur.revision} → v${cur.revision + 1})` : other ? 'დასახელება / სტატუსი' : undefined });
    }

    // უარის მიზეზები
    const pkgRules = new Set((p.parts.scrub_rules ?? []).map((r) => r.code));
    const dbRules = new Set((await this.db.selectFrom('scrub_rules').select('code').execute()).map((r) => r.code));
    if (has('denial_reasons')) for (const r of arr<NonNullable<ConfigPackage['parts']['denial_reasons']>[number]>('denial_reasons', p.parts.denial_reasons)) {
      const key = String(r.code);
      if (!/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(key) || String(r.title ?? '').trim().length < 2 || !['clinical', 'coding', 'admin', 'tariff', 'duplicate', 'other'].includes(r.category)
        || ![null, 'patient', 'writeoff'].includes(r.default_action)) { add({ part: 'denial_reasons', key, action: 'error', detail: 'კოდი / დასახელება / კატეგორია / ქმედება' }); continue; }
      const miss = (r.scrub_rules ?? []).filter((c) => !dbRules.has(c) && !(has('scrub_rules') && pkgRules.has(c)));
      if (miss.length) { add({ part: 'denial_reasons', key, action: 'error', detail: `წესი ვერ მოიძებნა: ${miss.join(', ')}` }); continue; }
      const cur = await this.db.selectFrom('denial_reasons').selectAll().where('code', '=', key).executeTakeFirst();
      if (!cur) { add({ part: 'denial_reasons', key, action: 'create', detail: r.title }); continue; }
      const same = cur.title === r.title.trim() && cur.category === r.category && stableJson(cur.external_codes) === stableJson(r.external_codes ?? []) && cur.default_action === r.default_action
        && cur.is_active === (r.is_active !== false) && cur.sort_order === (r.sort_order ?? 100) && stableJson(cur.scrub_rules) === stableJson(r.scrub_rules ?? []);
      add({ part: 'denial_reasons', key, action: same ? 'unchanged' : 'update' });
    }

    // გადამხდელის მიბმა
    const pkgTpl = new Set((p.parts.claim_templates ?? []).map((t) => t.code));
    const pkgSch = new Set((p.parts.drg?.schemes ?? []).map((s) => s.code));
    if (has('payers')) for (const x of arr<NonNullable<ConfigPackage['parts']['payers']>[number]>('payers', p.parts.payers)) {
      const key = String(x.code);
      const cur = await this.db.selectFrom('payers as p').leftJoin('drg_schemes as s', 's.id', 'p.drg_scheme_id').leftJoin('claim_templates as e', 'e.id', 'p.export_template_id')
        .leftJoin('claim_templates as r', 'r.id', 'p.response_template_id').select(['p.id', 's.code as sc', 'e.code as ec', 'r.code as rc']).where('p.code', '=', key).executeTakeFirst();
      if (!cur) { add({ part: 'payers', key, action: 'skip', detail: 'გადამხდელი ამ სისტემაში არ არის (კოდით)' }); continue; }
      const tplOk = async (c: string | null) => !c || pkgTpl.has(c) && has('claim_templates') || !!(await this.db.selectFrom('claim_templates').select('id').where('code', '=', c).executeTakeFirst());
      const schOk = async (c: string | null) => !c || pkgSch.has(c) && has('drg') || !!(await this.db.selectFrom('drg_schemes').select('id').where('code', '=', c).executeTakeFirst());
      if (!(await schOk(x.drg_scheme_code)) || !(await tplOk(x.export_template_code)) || !(await tplOk(x.response_template_code))) {
        add({ part: 'payers', key, action: 'error', detail: 'სქემა / შაბლონი ვერ მოიძებნა' }); continue;
      }
      const same = (cur.sc ?? null) === (x.drg_scheme_code ?? null) && (cur.ec ?? null) === (x.export_template_code ?? null) && (cur.rc ?? null) === (x.response_template_code ?? null);
      add({ part: 'payers', key, action: same ? 'unchanged' : 'update', detail: same ? undefined : [x.drg_scheme_code && `DRG ${x.drg_scheme_code}`, x.export_template_code, x.response_template_code].filter(Boolean).join(' · ') });
    }
    return lines;
  }

  private ruleError(r: NonNullable<ConfigPackage['parts']['scrub_rules']>[number], payers: Map<string, string>): string | null {
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(String(r.code))) return 'კოდი';
    if (!['error', 'warn'].includes(r.severity)) return 'სიმძიმე';
    if (!Array.isArray(r.payer_kinds) || r.payer_kinds.some((k) => !['insurance', 'state', 'other'].includes(k))) return 'გადამხდელის ტიპები';
    const missP = (r.payer_codes ?? []).filter((c) => !payers.has(c));
    if (missP.length) return `გადამხდელი ვერ მოიძებნა: ${missP.join(', ')}`;
    if (r.builtin) {
      const defs = BUILTIN_PARAMS[r.code] ?? [];
      for (const [k, v] of Object.entries(r.params ?? {})) {
        const d = defs.find((x) => x.key === k);
        if (!d) return `უცნობი პარამეტრი ${k}`;
        if (d.type === 'int' && (!Number.isInteger(v) || (v as number) < 0)) return `${k}: მთელი რიცხვი`;
        if (d.type === 'patterns' && (!Array.isArray(v) || (v as unknown[]).some((x) => !PATTERN_RE.test(normPattern(String(x)))))) return `${k}: კოდები`;
      }
      return null;
    }
    if (!r.code.startsWith('X_')) return 'საკუთარი წესის კოდი იწყება X_-ით';
    if (String(r.title ?? '').trim().length < 2) return 'დასახელება';
    const c = parseConds(String(r.conditions_text ?? ''), new Map());
    if ('error' in c) return `პირობები: ${c.error}`;
    if (!c.conds.length) return 'პირობა არ არის';
    if (c.conds.some((x) => CUSTOM_FORBIDDEN.has(x.f))) return 'ველი cc დაუშვებელია';
    for (const x of c.conds) { const e = validateCond(x, new Map()); if (e) return e; }
    return null;
  }
  private ruleDiff(cur: { message: string | null; severity: string; is_active: boolean; payer_kinds: string[]; payer_ids: string[]; params: unknown; conditions: unknown; allow_override: boolean; title: string; builtin: boolean },
    r: NonNullable<ConfigPackage['parts']['scrub_rules']>[number], payers: Map<string, string>) {
    const d: string[] = [];
    if ((cur.message ?? null) !== (r.message ?? null)) d.push('ტექსტი');
    if (cur.severity !== r.severity) d.push(`სიმძიმე ${cur.severity} → ${r.severity}`);
    if (cur.is_active !== r.is_active) d.push(r.is_active ? 'ჩართვა' : 'გამორთვა');
    if (stableJson([...cur.payer_kinds].sort()) !== stableJson([...r.payer_kinds].sort())) d.push('გადამხდელის ტიპები');
    if (stableJson([...cur.payer_ids].sort()) !== stableJson((r.payer_codes ?? []).map((c) => payers.get(c)!).sort())) d.push('გადამხდელები');
    if (cur.allow_override !== r.allow_override) d.push('გამონაკლისი');
    if (cur.builtin && stableJson(cur.params ?? {}) !== stableJson(r.params ?? {})) d.push('პარამეტრები');
    if (!cur.builtin && (cur.title !== r.title || condsText(cur.conditions as Cond[]) !== String(r.conditions_text ?? '').trim())) d.push('დასახელება / პირობები');
    return d;
  }

  async preview(buf: Buffer, only: Part[], u: AuthUser, ctx: AuditContext) {
    const p = this.parse(buf);
    const lines = await this.plan(p, only, u, ctx);
    return this.summary(p, lines, buf);
  }
  private summary(p: ConfigPackage, lines: PlanLine[], buf: Buffer) {
    const count = (a: PlanLine['action']) => lines.filter((l) => l.action === a).length;
    return { source: p.source ?? null, exported_at: p.exported_at, sha256: createHash('sha256').update(buf).digest('hex'),
      parts: PARTS.filter((k) => p.parts[k] !== undefined), totals: { create: count('create'), update: count('update'), unchanged: count('unchanged'), skip: count('skip'), error: count('error') }, lines };
  }

  // ---------------------------------------------------------------- იმპორტი: ჩაწერა
  async apply(buf: Buffer, only: Part[], u: AuthUser, ctx: AuditContext) {
    const p = this.parse(buf);
    const lines = await this.plan(p, only, u, ctx);
    const errs = lines.filter((l) => l.action === 'error');
    if (errs.length) throw new BadRequestException({ code: 'CONFIG_PACKAGE_INVALID', message: `პაკეტი: ${errs.length} შეცდომა — ${errs.slice(0, 3).map((e) => `${e.key}: ${e.detail}`).join('; ')}`, lines: errs });
    const todo = (part: Part, key: string) => lines.some((l) => l.part === part && l.key === key && (l.action === 'create' || l.action === 'update'));
    const sha = createHash('sha256').update(buf).digest('hex');

    // 1) ერთ ტრანზაქციაში: მოდულები, სქემები, წესები, შაბლონები, მიზეზები, გადამხდელები
    await this.db.transaction().execute(async (trx) => {
      for (const m of p.parts.modules ?? []) {
        if (!only.includes('modules') || !todo('modules', m.code)) continue;
        const cur = await trx.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', m.code).forUpdate().executeTakeFirstOrThrow();
        const next = { ...((cur.settings ?? {}) as object), ...(m.settings ?? {}) };
        const v = VALIDATORS[m.code];
        const err = v?.extra ? await v.extra(next, trx as unknown as Database) : null;
        if (err) throw new BadRequestException(`მოდული ${m.code}: ${err}`);
        await trx.updateTable('system_modules').set({ enabled: !!m.enabled, settings: JSON.stringify(next), updated_by: u.id, updated_at: sql`now()` }).where('code', '=', m.code).execute();
        await this.audit.log(ctx, { action: 'UPDATE_MODULE', entityName: 'system_modules', entityId: m.code, oldData: cur, newData: { enabled: m.enabled, settings: next, reason: `კონფიგურაციის პაკეტი ${sha.slice(0, 12)}` } }, trx);
      }
      if (only.includes('drg')) for (const s of p.parts.drg?.schemes ?? []) {
        if (!todo('drg', `სქემა ${s.code}`)) continue;
        await trx.insertInto('drg_schemes').values({ code: s.code, name: s.name.trim(), notes: s.notes ?? null, is_default: false }).execute();
      }
      const payers = new Map((await trx.selectFrom('payers').select(['id', 'code']).execute()).map((x) => [x.code, x.id]));
      if (only.includes('scrub_rules')) for (const r of p.parts.scrub_rules ?? []) {
        if (!todo('scrub_rules', r.code)) continue;
        const base = { message: r.message?.trim() || null, severity: r.severity, is_active: !!r.is_active, payer_kinds: r.payer_kinds, payer_ids: (r.payer_codes ?? []).map((c) => payers.get(c)!),
          allow_override: !!r.allow_override, updated_by: u.id, updated_at: sql<Date>`now()` };
        const exists = await trx.selectFrom('scrub_rules').select('code').where('code', '=', r.code).executeTakeFirst();
        if (r.builtin) {
          const params = Object.fromEntries(Object.entries(r.params ?? {}).map(([k, v]) => [k, Array.isArray(v) ? [...new Set(v.map((x) => normPattern(String(x))))] : v]));
          await trx.updateTable('scrub_rules').set({ ...base, params: JSON.stringify(params) }).where('code', '=', r.code).execute();
        } else {
          const c = parseConds(String(r.conditions_text), new Map()) as { conds: Cond[] };
          if (exists) await trx.updateTable('scrub_rules').set({ ...base, title: r.title.trim(), conditions: JSON.stringify(c.conds) }).where('code', '=', r.code).execute();
          else await trx.insertInto('scrub_rules').values({ ...base, code: r.code, builtin: false, grp: 'custom', title: r.title.trim(), applies_kind: 'ipd', conditions: JSON.stringify(c.conds), sort_order: 500 }).execute();
        }
        await this.audit.log(ctx, { action: exists ? 'SCRUB_RULE_UPDATE' : 'SCRUB_RULE_CREATE', entityName: 'scrub_rules', entityId: r.code, newData: { ...r, source: `პაკეტი ${sha.slice(0, 12)}` } }, trx);
      }
      if (only.includes('claim_templates')) for (const t of p.parts.claim_templates ?? []) {
        if (!todo('claim_templates', t.code)) continue;
        const cfg = t.kind === 'export' ? validateExport(t.config, t.format).cfg : validateResponse(t.config).cfg;
        const cur = await trx.selectFrom('claim_templates').selectAll().where('code', '=', t.code).forUpdate().executeTakeFirst();
        if (!cur) {
          await trx.insertInto('claim_templates').values({ code: t.code, name: t.name.trim(), kind: t.kind, format: t.format, config: JSON.stringify(cfg), notes: t.notes ?? null,
            is_active: t.is_active !== false, created_by: u.id, updated_by: u.id }).execute();
        } else {
          const prev = cur.kind === 'export' ? validateExport(cur.config, cur.format).cfg : validateResponse(cur.config).cfg;
          const ch = stableJson(prev) !== stableJson(cfg) || cur.format !== t.format;
          await trx.updateTable('claim_templates').set({ name: t.name.trim(), notes: t.notes ?? null, is_active: t.is_active !== false, updated_by: u.id,
            ...(ch && { format: t.format, config: JSON.stringify(cfg), revision: cur.revision + 1 }) }).where('id', '=', cur.id).execute();
        }
        await this.audit.log(ctx, { action: cur ? 'CLAIM_TEMPLATE_UPDATE' : 'CLAIM_TEMPLATE_CREATE', entityName: 'claim_templates', entityId: t.code, newData: { code: t.code, source: `პაკეტი ${sha.slice(0, 12)}` } }, trx);
      }
      if (only.includes('denial_reasons')) for (const r of p.parts.denial_reasons ?? []) {
        if (!todo('denial_reasons', r.code)) continue;
        const row = { title: r.title.trim(), category: r.category, external_codes: [...new Set((r.external_codes ?? []).map((x) => x.trim()).filter(Boolean))], default_action: r.default_action,
          is_active: r.is_active !== false, sort_order: r.sort_order ?? 100, scrub_rules: r.scrub_rules ?? [] };
        await trx.insertInto('denial_reasons').values({ code: r.code, ...row }).onConflict((oc) => oc.column('code').doUpdateSet(row)).execute();
        await this.audit.log(ctx, { action: 'DENIAL_REASON_UPDATE', entityName: 'denial_reasons', entityId: r.code, newData: { ...row, source: `პაკეტი ${sha.slice(0, 12)}` } }, trx);
      }
      if (only.includes('payers')) for (const x of p.parts.payers ?? []) {
        if (!todo('payers', x.code)) continue;
        const id = async (t: 'claim_templates' | 'drg_schemes', c: string | null) => (c ? (await trx.selectFrom(t).select('id').where('code', '=', c).executeTakeFirstOrThrow()).id : null);
        await trx.updateTable('payers').set({ drg_scheme_id: await id('drg_schemes', x.drg_scheme_code), export_template_id: await id('claim_templates', x.export_template_code),
          response_template_id: await id('claim_templates', x.response_template_code) }).where('code', '=', x.code).execute();
        await this.audit.log(ctx, { action: 'PAYER_CLAIM_TEMPLATES', entityName: 'payers', entityId: x.code, newData: { ...x, source: `პაკეტი ${sha.slice(0, 12)}` } }, trx);
      }
    });

    // 2) DRG ვერსიები — მონახაზად (თითო — საკუთარი ტრანზაქცია; შიგთავსი უკვე შემოწმებულია)
    const created: { key: string; id: string; version_no: number }[] = [];
    if (only.includes('drg')) for (const v of p.parts.drg?.versions ?? []) {
      const key = `${v.scheme_code}: ${v.package?.label ?? '—'} (${v.package?.valid_from ?? '—'})`;
      if (!todo('drg', key)) continue;
      const sch = await this.db.selectFrom('drg_schemes').select('id').where('code', '=', v.scheme_code).executeTakeFirstOrThrow();
      const r = await this.drg.importPackage(sch.id, { package: v.package as unknown as Record<string, unknown> }, u, ctx, 'DRG_VERSION_IMPORT');
      created.push({ key, id: r.id!, version_no: r.version_no });
    }
    const s = this.summary(p, lines, buf);
    await this.audit.log(ctx, { action: 'CONFIG_PACKAGE_IMPORT', entityName: 'config_package', entityId: sha.slice(0, 64), newData: { source: p.source, exported_at: p.exported_at, parts: only, totals: s.totals,
      drg_versions: created } });
    return { ...s, applied: true, drg_versions: created };
  }
}

const partsOf = (q?: string): Part[] => {
  if (!q) return [...PARTS];
  const x = q.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = x.filter((k) => !(PARTS as readonly string[]).includes(k));
  if (bad.length) throw new BadRequestException(`ნაწილი: ${bad.join(', ')} (${PARTS.join(' | ')})`);
  return x as Part[];
};

@Controller('config-package')
export class ConfigPackageController {
  constructor(private readonly s: ConfigPackageService) {}
  @Get('meta') @Roles(...EXPORT_ROLES) meta() { return { parts: PARTS.map((k) => ({ code: k, title: PART_KA[k] })) }; }
  @Get() @Roles(...EXPORT_ROLES)
  async export(@Query('parts') parts: string | undefined, @Query('drg_version_ids') vids: string | undefined, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const ids = vids ? vids.split(',').filter(Boolean) : null;
    if (ids?.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) throw new BadRequestException('drg_version_ids');
    const out = await this.s.export(partsOf(parts), ids, auditCtx(r));
    res.set({ 'Content-Disposition': `attachment; filename="emr-config-${out.exported_at.slice(0, 10)}.json"` });
    return out;
  }
  @Post('preview') @HttpCode(200) @Roles('admin') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }))
  preview(@UploadedFile() file: Express.Multer.File | undefined, @Query('parts') parts: string | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი file)');
    return this.s.preview(file.buffer, partsOf(parts), u, auditCtx(r));
  }
  @Post('import') @HttpCode(200) @Roles('admin') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }))
  import(@UploadedFile() file: Express.Multer.File | undefined, @Query('parts') parts: string | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი file)');
    return this.s.apply(file.buffer, partsOf(parts), u, auditCtx(r));
  }
}

@Module({ imports: [DrgModule], providers: [ConfigPackageService], controllers: [ConfigPackageController] })
export class ConfigPackageModule {}
