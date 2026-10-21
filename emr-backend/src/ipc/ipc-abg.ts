import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res,
  StreamableFile } from '@nestjs/common';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IPC_STATUS_READ, IpcCommon } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
const GRAM_KA: Record<string, string> = { neg: 'გრამ-უარყოფითი', pos: 'გრამ-დადებითი', fungus: 'სოკოები', other: 'სხვა' };
const GRAMS = ['neg', 'pos', 'fungus', 'other'];
const CARE_KA: Record<string, string> = { icu: 'ICU / ინტენსიური', non_icu: 'ICU-ს გარეშე' };
const SETTING_KA: Record<string, string> = { inpatient: 'სტაციონარი', outpatient: 'ამბულატორია / გადაუდებელი' };

export interface AbgFilters { from: string; to: string; department_id?: string; care?: string; setting?: string; service_id?: string; gram?: string }
type AbgQuery = { from?: string; to?: string; department_id?: string; care?: string; setting?: string; service_id?: string; gram?: string; format?: string; id?: string };
class PublishDto {
  @IsString() @Length(3, 200) title: string;
  @IsDateString() from: string;
  @IsDateString() to: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsIn(['icu', 'non_icu']) care?: string;
  @IsOptional() @IsIn(['inpatient', 'outpatient']) setting?: string;
  @IsOptional() @IsUUID() service_id?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
class WithdrawDto { @IsString() @Length(3, 500) reason: string }

type Abx = { id: string; code: string; name: string; class: string | null };
type CellV = { n: number; s: number; i: number; r: number; pct: number } | null;
export interface AbgData {
  from: string; to: string; dedup: string; min_n: number; label: string; excluded_services: string[];
  isolates_raw: number; isolates: number; patients: number;
  sections: { gram: string; label: string; antibiotics: Abx[]; rows: { organism_id: string; code: string; name: string; n: number; low: boolean; cells: CellV[] }[] }[];
  mdro: { code: string; name: string; target: string; denominator: number; n: number; pct: number | null; low: boolean }[];
}

/**
 * კუმულაციური ანტიბიოგრამა (0071, CLSI M39):
 *  • წყარო — საბოლოო პასუხი (micro_reports.kind = final), ყველა ტესტირებული ანტიბიოტიკი (S / I / R); თარიღი — ნიმუშის აღება (ან დანიშვნა);
 *  • განყოფილება — აღების მომენტის საწოლი (სტაციონარი) ან ვიზიტის განყოფილება; სკრინინგის ანალიზები (abg_exclude_services) — გამორიცხული;
 *  • დუბლიკატები — პირველი იზოლატი პაციენტზე × მიკროორგანიზმზე პერიოდში (abg_dedup = first_patient), ფილტრების შემდეგ;
 *  • %S = S / ტესტირებული („I“ — არა მგრძნობიარე); n < abg_min_n — „სტატისტიკურად არასანდო“;
 *  • MDRO წილი — 0067-ის წესებით (მიზნობრივი მიკროორგანიზმების დედუპლიცირებულ იზოლატებში);
 *  • გამოქვეყნება — უცვლელი ვერსია (snapshot), ხედავს ყველა კლინიცისტი; ექსპორტი xlsx / PDF.
 */
@Injectable()
export class IpcAbgService {
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  private check(q: AbgQuery): AbgFilters {
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
    if (days > 366 * 3) throw new BadRequestException({ code: 'RANGE', message: 'პერიოდი — მაქსიმუმ 3 წელი' });
    const uuid = /^[0-9a-f-]{36}$/i;
    if (q.department_id && !uuid.test(q.department_id)) throw new BadRequestException('department_id');
    if (q.service_id && !uuid.test(q.service_id)) throw new BadRequestException('service_id');
    if (q.care && !['icu', 'non_icu'].includes(q.care)) throw new BadRequestException('care: icu / non_icu');
    if (q.setting && !['inpatient', 'outpatient'].includes(q.setting)) throw new BadRequestException('setting: inpatient / outpatient');
    if (q.gram && !GRAMS.includes(q.gram)) throw new BadRequestException('gram: neg / pos / fungus / other');
    return { from: q.from, to: q.to, department_id: q.department_id || undefined, care: q.care || undefined, setting: q.setting || undefined,
      service_id: q.service_id || undefined, gram: q.gram || undefined };
  }

  async meta() {
    const r = await this.c.rules();
    const [departments, services] = await Promise.all([
      this.db.selectFrom('departments').select(['id', 'name', 'care_level']).where('is_active', '=', true).where('type', '<>', 'administrative').orderBy('name').execute(),
      sql<{ id: string; code: string; name: string }>`
        SELECT s.id, s.code, s.name FROM dx_services s WHERE s.section = 'lab'
           AND (EXISTS (SELECT 1 FROM dx_order_items i JOIN micro_cultures c ON c.order_item_id = i.id WHERE i.service_id = s.id) OR s.id = ANY(${sql.val(r.abg_exclude_services)}::uuid[]))
         ORDER BY s.name`.execute(this.db).then((x) => x.rows),
    ]);
    return { departments, services, dedup: r.abg_dedup, min_n: r.abg_min_n, exclude_services: r.abg_exclude_services };
  }

  private async label(f: AbgFilters) {
    const parts: string[] = [];
    if (f.department_id) parts.push((await this.db.selectFrom('departments').select('name').where('id', '=', f.department_id).executeTakeFirst())?.name ?? 'განყოფილება');
    else parts.push('მთელი კლინიკა');
    if (f.care) parts.push(CARE_KA[f.care]);
    if (f.setting) parts.push(SETTING_KA[f.setting]);
    if (f.service_id) parts.push((await this.db.selectFrom('dx_services').select('name').where('id', '=', f.service_id).executeTakeFirst())?.name ?? 'ანალიზი');
    if (f.gram) parts.push(GRAM_KA[f.gram]);
    return parts.join(' · ');
  }

  /** გამოთვლა; depts — infection_dept-ის არე (null = მთელი კლინიკა) */
  async compute(f: AbgFilters, depts: string[] | null): Promise<AbgData> {
    const r = await this.c.rules();
    const excl = r.abg_exclude_services;
    const iso = (await sql<{ isolate_id: string; seq: number; markers: string[]; organism_id: string; org_code: string; org_name: string; gram: string; group_code: string;
      patient_id: string; taken_at: string; department_id: string | null; care_level: string | null; inpatient: boolean }>`
      WITH x AS (
        SELECT mi.id AS isolate_id, mi.seq, mi.markers, o.id AS organism_id, lower(o.code) AS org_code, o.name AS org_name, o.gram, o.group_code, i.patient_id, i.service_id,
               coalesce(sp.collected_at, i.ordered_at) AS taken_at,
               EXISTS (SELECT 1 FROM inpatient_stays st WHERE st.encounter_id = i.encounter_id) AS inpatient,
               coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = i.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
                          AND a.started_at <= coalesce(sp.collected_at, i.ordered_at) ORDER BY a.started_at DESC LIMIT 1),
                        (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = i.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel' ORDER BY a.started_at LIMIT 1),
                        e.department_id) AS department_id
          FROM micro_isolates mi JOIN micro_cultures c ON c.id = mi.culture_id JOIN dx_order_items i ON i.id = c.order_item_id
          JOIN micro_organisms o ON o.id = mi.organism_id LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id LEFT JOIN encounters e ON e.id = i.encounter_id
         WHERE i.status <> 'cancelled' AND EXISTS (SELECT 1 FROM micro_reports rp WHERE rp.order_item_id = i.id AND rp.kind = 'final')
           AND (coalesce(sp.collected_at, i.ordered_at) AT TIME ZONE ${TZ})::date BETWEEN ${f.from}::date AND ${f.to}::date
           AND NOT (i.service_id = ANY(${sql.val(excl)}::uuid[])))
      SELECT x.isolate_id, x.seq, x.markers, x.organism_id, x.org_code, x.org_name, x.gram, x.group_code, x.patient_id, x.taken_at::text AS taken_at,
             x.department_id, d.care_level, x.inpatient
        FROM x LEFT JOIN departments d ON d.id = x.department_id
       WHERE true
         ${f.service_id ? sql`AND x.service_id = ${f.service_id}` : sql``}
         ${f.department_id ? sql`AND x.department_id = ${f.department_id}` : sql``}
         ${depts ? sql`AND x.department_id = ANY(${sql.val(depts)}::uuid[])` : sql``}
         ${f.care === 'icu' ? sql`AND d.care_level IN ('icu', 'intensive')` : f.care === 'non_icu' ? sql`AND (d.care_level IS NULL OR d.care_level NOT IN ('icu', 'intensive'))` : sql``}
         ${f.setting === 'inpatient' ? sql`AND x.inpatient` : f.setting === 'outpatient' ? sql`AND NOT x.inpatient` : sql``}
         ${f.gram ? sql`AND x.gram = ${f.gram}` : sql``}
       ORDER BY x.taken_at, x.seq, x.isolate_id`.execute(this.db)).rows;
    // დუბლიკატები: პირველი იზოლატი პაციენტზე × მიკროორგანიზმზე
    const seen = new Set<string>();
    const kept = r.abg_dedup === 'all' ? iso : iso.filter((x) => { const k = `${x.patient_id}|${x.organism_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const ids = kept.map((x) => x.isolate_id);
    const ast = ids.length ? (await sql<{ isolate_id: string; id: string; code: string; name: string; class: string | null; interp: string }>`
      SELECT a.isolate_id, ab.id, upper(ab.code) AS code, ab.name, ab.class, a.interp FROM micro_ast a JOIN micro_antibiotics ab ON ab.id = a.antibiotic_id
       WHERE a.isolate_id = ANY(${sql.val(ids)}::uuid[]) AND a.interp IS NOT NULL`.execute(this.db)).rows : [];
    const byIso = new Map<string, typeof ast>();
    for (const a of ast) { const l = byIso.get(a.isolate_id) ?? []; l.push(a); byIso.set(a.isolate_id, l); }
    const minN = r.abg_min_n;
    const sections: AbgData['sections'] = [];
    for (const g of GRAMS) {
      const gi = kept.filter((x) => x.gram === g);
      if (!gi.length) continue;
      const abxMap = new Map<string, Abx>();
      gi.forEach((x) => (byIso.get(x.isolate_id) ?? []).forEach((a) => abxMap.set(a.id, { id: a.id, code: a.code, name: a.name, class: a.class })));
      const antibiotics = [...abxMap.values()].sort((a, b) => (a.class ?? 'ჰ').localeCompare(b.class ?? 'ჰ') || a.code.localeCompare(b.code));
      const orgs = [...new Set(gi.map((x) => x.organism_id))];
      const rows = orgs.map((oid) => {
        const oi = gi.filter((x) => x.organism_id === oid);
        const cells: CellV[] = antibiotics.map((ab) => {
          const t = oi.flatMap((x) => (byIso.get(x.isolate_id) ?? []).filter((a) => a.id === ab.id));
          if (!t.length) return null;
          const s = t.filter((a) => a.interp === 'S').length; const i = t.filter((a) => a.interp === 'I').length;
          return { n: t.length, s, i, r: t.length - s - i, pct: Math.round((s / t.length) * 100) };
        });
        return { organism_id: oid, code: oi[0].org_code, name: oi[0].org_name, n: oi.length, low: oi.length < minN, cells };
      }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
      sections.push({ gram: g, label: GRAM_KA[g], antibiotics, rows });
    }
    // MDRO წილი (0067-ის წესები; მხოლოდ რეზისტენტობის / მარკერის პირობით)
    const rules = await this.db.selectFrom('ipc_mdro_rules as ru').innerJoin('ipc_mdro_types as t', 't.code', 'ru.mdro_code')
      .select(['ru.mdro_code', 't.name', 't.sort_order', 'ru.organism_codes', 'ru.group_codes', 'ru.abx_codes', 'ru.marker'])
      .where('ru.is_active', '=', true).where('t.is_active', '=', true).orderBy('t.sort_order').execute();
    const target = (ru: (typeof rules)[number], x: (typeof kept)[number]) => ru.organism_codes.map((c) => c.toLowerCase()).includes(x.org_code) || ru.group_codes.includes(x.group_code);
    const hit = (ru: (typeof rules)[number], x: (typeof kept)[number]) => {
      if (!target(ru, x)) return false;
      const rc = (byIso.get(x.isolate_id) ?? []).filter((a) => a.interp === 'R').map((a) => a.code);
      return (!ru.abx_codes.length || ru.abx_codes.some((c) => rc.includes(c.toUpperCase()))) && (!ru.marker || x.markers.includes(ru.marker));
    };
    const mdro: AbgData['mdro'] = [];
    for (const code of [...new Set(rules.map((x) => x.mdro_code))]) {
      const rs = rules.filter((x) => x.mdro_code === code && (x.abx_codes.length > 0 || !!x.marker));
      if (!rs.length) continue;
      const den = kept.filter((x) => rs.some((ru) => target(ru, x)));
      const n = den.filter((x) => rs.some((ru) => hit(ru, x))).length;
      const tg = [...new Set(rs.flatMap((ru) => [...ru.organism_codes.map((c) => c.toLowerCase()), ...ru.group_codes]))];
      mdro.push({ code, name: rs[0].name, target: tg.join(', '), denominator: den.length, n, pct: den.length ? Math.round((n / den.length) * 1000) / 10 : null, low: den.length < minN });
    }
    const excludedNames = excl.length ? (await this.db.selectFrom('dx_services').select('name').where('id', 'in', excl).orderBy('name').execute()).map((x) => x.name) : [];
    return { from: f.from, to: f.to, dedup: r.abg_dedup, min_n: minN, label: await this.label(f), excluded_services: excludedNames,
      isolates_raw: iso.length, isolates: kept.length, patients: new Set(kept.map((x) => x.patient_id)).size, sections, mdro };
  }

  private async depts(u: AuthUser, f: AbgFilters) {
    const sc = await this.c.scope(u);
    if (sc.full) return null;
    if (f.department_id && !sc.depts.includes(f.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
    return sc.depts;
  }

  async current(u: AuthUser, q: AbgQuery) {
    const f = this.check(q);
    return this.compute(f, await this.depts(u, f));
  }

  // =============================================================== გამოქვეყნება
  async publish(u: AuthUser, d: PublishDto, req: Request) {
    const f = this.check({ from: d.from?.slice(0, 10), to: d.to?.slice(0, 10), department_id: d.department_id, care: d.care, setting: d.setting, service_id: d.service_id });
    const data = await this.compute(f, null);
    if (!data.isolates) throw new ConflictException({ code: 'NO_DATA', message: 'პერიოდში საბოლოო პასუხით იზოლატი არ არის' });
    const row = await this.db.insertInto('ipc_antibiograms').values({ title: d.title.trim(), period_from: f.from, period_to: f.to,
      filters: JSON.stringify({ ...f, dedup: data.dedup, min_n: data.min_n }), filters_label: data.label, data: JSON.stringify(data), isolates: data.isolates,
      note: d.note?.trim() || null, published_by: u.id }).returning(['id', 'title', 'period_from', 'period_to', 'isolates', 'published_at']).executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'IPC_ABG_PUBLISH', entityName: 'ipc_antibiograms', entityId: row.id,
      newData: { title: row.title, from: f.from, to: f.to, label: data.label, isolates: data.isolates } });
    return row;
  }

  async published(u: AuthUser, all?: boolean) {
    await this.c.rules();
    let x = this.db.selectFrom('ipc_antibiograms as a').innerJoin('users as pb', 'pb.id', 'a.published_by')
      .select(['a.id', 'a.title', 'a.period_from', 'a.period_to', 'a.filters_label', 'a.isolates', 'a.note', 'a.status', 'a.published_at', 'a.withdrawn_at', 'a.withdraw_reason',
        sql<string>`pb.last_name || ' ' || pb.first_name`.as('published_by_name')])
      .orderBy('a.published_at', 'desc').limit(200);
    if (!(all && has(u, ...IPC_FULL))) x = x.where('a.status', '=', 'published');
    return x.execute();
  }

  async one(u: AuthUser, id: string) {
    await this.c.rules();
    const a = await this.db.selectFrom('ipc_antibiograms as a').innerJoin('users as pb', 'pb.id', 'a.published_by').selectAll('a')
      .select(sql<string>`pb.last_name || ' ' || pb.first_name`.as('published_by_name')).where('a.id', '=', id).executeTakeFirst();
    if (!a || (a.status !== 'published' && !has(u, ...IPC_FULL))) throw new NotFoundException('ანტიბიოგრამა ვერ მოიძებნა');
    return { ...a, data: a.data as unknown as AbgData };
  }

  async withdraw(u: AuthUser, id: string, d: WithdrawDto, req: Request) {
    await this.c.rules();
    const r = await this.db.updateTable('ipc_antibiograms').set({ status: 'withdrawn', withdrawn_by: u.id, withdrawn_at: sql`now()`, withdraw_reason: d.reason.trim() })
      .where('id', '=', id).where('status', '=', 'published').returning(['id', 'title']).executeTakeFirst();
    if (!r) throw new ConflictException({ code: 'NOT_PUBLISHED', message: 'ანტიბიოგრამა ვერ მოიძებნა ან უკვე გაუქმებულია' });
    await this.audit.log(auditCtx(req), { action: 'IPC_ABG_WITHDRAW', entityName: 'ipc_antibiograms', entityId: id, newData: { reason: d.reason.trim() } });
    return { ok: true };
  }

  // =============================================================== ექსპორტი
  async export(u: AuthUser, q: AbgQuery, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'pdf'].includes(format)) throw new BadRequestException('format: xlsx / pdf');
    let data: AbgData; let title: string; let meta: string;
    if (q.id) {
      const a = await this.one(u, q.id);
      data = a.data; title = a.title;
      meta = `გამოქვეყნდა ${new Date(a.published_at).toLocaleDateString('ka-GE', { timeZone: TZ })} · ${a.published_by_name}${a.status === 'withdrawn' ? ' · გაუქმებულია' : ''}`;
    } else {
      if (!has(u, ...IPC_ANY)) throw new ForbiddenException('მიმდინარე ანტიბიოგრამა — მხოლოდ ინფექციის კონტროლი');
      data = await this.current(u, q); title = 'ანტიბიოგრამა (მიმდინარე, გამოუქვეყნებელი)'; meta = `შექმნილია ${new Date().toLocaleString('ka-GE', { timeZone: TZ })}`;
    }
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    const base = `antibiogram_${data.from}_${data.to}`;
    await this.audit.log(auditCtx(req), { action: 'IPC_ABG_EXPORT', entityName: 'ipc_antibiograms', entityId: q.id ?? 'current', newData: { format, from: data.from, to: data.to } });
    if (format === 'xlsx') return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(this.sheets(data, title, meta, clinic)) };
    return { name: `${base}.pdf`, type: 'application/pdf', body: await this.pdf(data, title, meta, clinic) };
  }

  private headLines(d: AbgData, title: string, meta: string, clinic: string) {
    return [clinic, title, `${d.from} — ${d.to} · ${d.label}`, meta,
      `იზოლატები: ${d.isolates} (დუბლიკატების მოცილებამდე ${d.isolates_raw}), პაციენტები: ${d.patients} · ${d.dedup === 'first_patient' ? 'პირველი იზოლატი პაციენტზე (CLSI M39)' : 'ყველა იზოლატი'}`,
      `%S — მგრძნობიარე / ტესტირებული („I“ არ ითვლება). n < ${d.min_n} — სტატისტიკურად არასანდო (*).${d.excluded_services.length ? ` გამორიცხულია: ${d.excluded_services.join(', ')}` : ''}`];
  }

  private sheets(d: AbgData, title: string, meta: string, clinic: string): SheetSpec[] {
    const out: SheetSpec[] = [];
    const head = this.headLines(d, title, meta, clinic);
    for (const s of d.sections) {
      const hdr = ['მიკროორგანიზმი', 'n', ...s.antibiotics.map((a) => a.code)];
      const rows: Cell[][] = [...head.map((h) => [h]), [], ['', '', ...s.antibiotics.map((a) => a.name)], hdr,
        ...s.rows.map((r) => [`${r.name}${r.low ? ' *' : ''}`, { v: r.n, fmt: '0' }, ...r.cells.map((c) => (c ? { v: c.pct, fmt: '0' } : null))] as Cell[])];
      out.push({ name: s.label.slice(0, 31), rows, boldRows: [1, head.length + 2], widths: [34, 6, ...s.antibiotics.map(() => 7)] });
    }
    out.push({ name: 'MDRO', rows: [...head.map((h) => [h]), [], ['MDRO', 'მიზნობრივი', 'მნიშვნელი (n)', 'MDRO', '%'],
      ...d.mdro.map((m) => [`${m.name}${m.low ? ' *' : ''}`, m.target, { v: m.denominator, fmt: '0' }, { v: m.n, fmt: '0' }, m.pct === null ? null : { v: m.pct, fmt: '0.0' }] as Cell[])],
      boldRows: [1, head.length + 1], widths: [48, 18, 14, 8, 8] });
    if (d.sections.length) {
      const legend: Cell[][] = [['კოდი', 'ანტიბიოტიკი', 'კლასი']];
      const all = new Map<string, Abx>(); d.sections.forEach((s) => s.antibiotics.forEach((a) => all.set(a.id, a)));
      [...all.values()].sort((a, b) => a.code.localeCompare(b.code)).forEach((a) => legend.push([a.code, a.name, a.class]));
      out.push({ name: 'კოდები', rows: legend, boldRows: [0], widths: [8, 30, 26] });
    }
    return out;
  }

  private async pdf(d: AbgData, title: string, meta: string, clinic: string): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 30, bottom: 34, left: 30, right: 30 }, bufferPages: true, info: { Title: title, Author: clinic } });
    doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (x: Buffer) => chunks.push(x));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const [cl, tt, per, mt, iso, note] = this.headLines(d, title, meta, clinic);
    doc.font('B').fontSize(9).fillColor('#555').text(cl, L, doc.y, { width: W });
    doc.font('B').fontSize(14).fillColor('black').text(tt, { width: W });
    doc.font('R').fontSize(8.5).fillColor('#333').text(`${per} · ${mt}`, { width: W }).text(iso, { width: W }).text(note, { width: W });
    const fill = (p: number) => (p >= 90 ? '#d7f0dc' : p >= 70 ? '#fdf1c7' : '#f9d6d2');
    for (const s of d.sections) {
      const nameW = 150; const nW = 26; const cols = s.antibiotics.length;
      const cw = Math.max(16, Math.min(34, (W - nameW - nW) / Math.max(cols, 1)));
      const head = () => {
        const y = doc.y; doc.font('B').fontSize(6.5).fillColor('#444');
        doc.text('მიკროორგანიზმი', L + 2, y + 14, { width: nameW - 4, lineBreak: false }); doc.text('n', L + nameW, y + 14, { width: nW - 2, align: 'right', lineBreak: false });
        s.antibiotics.forEach((a, i) => doc.text(a.code, L + nameW + nW + i * cw, y + 14, { width: cw, align: 'center', lineBreak: false }));
        doc.moveTo(L, y + 24).lineTo(L + nameW + nW + cols * cw, y + 24).strokeColor('#999').lineWidth(0.5).stroke(); doc.y = y + 26;
      };
      if (doc.y + 70 > bottom()) doc.addPage(); else doc.moveDown(0.6);
      doc.font('B').fontSize(10.5).fillColor('black').text(`${s.label} — %S`, L, doc.y, { width: W });
      head();
      for (const r of s.rows) {
        if (doc.y + 14 > bottom()) { doc.addPage(); head(); }
        const y = doc.y;
        doc.font('R').fontSize(7.5).fillColor(r.low ? '#777' : 'black').text(`${r.name}${r.low ? ' *' : ''}`, L + 2, y + 2, { width: nameW - 4, lineBreak: false, ellipsis: true });
        doc.text(String(r.n), L + nameW, y + 2, { width: nW - 2, align: 'right', lineBreak: false });
        r.cells.forEach((c, i) => {
          if (!c) return;
          const x = L + nameW + nW + i * cw;
          doc.rect(x + 0.5, y, cw - 1, 11).fill(fill(c.pct));
          doc.font('R').fontSize(7).fillColor(r.low ? '#777' : 'black').text(String(c.pct), x, y + 2, { width: cw, align: 'center', lineBreak: false });
        });
        doc.y = y + 12;
      }
      doc.x = L;
    }
    if (d.mdro.length) {
      if (doc.y + 60 > bottom()) doc.addPage(); else doc.moveDown(0.8);
      doc.font('B').fontSize(10.5).fillColor('black').text('MDRO წილი', L, doc.y, { width: W });
      for (const m of d.mdro) {
        if (doc.y + 12 > bottom()) doc.addPage();
        doc.font('R').fontSize(8).fillColor(m.low ? '#777' : 'black')
          .text(`${m.name}${m.low ? ' *' : ''}: ${m.pct === null ? '—' : `${m.pct}%`} (${m.n} / ${m.denominator})`, L, doc.y, { width: W });
      }
    }
    const legend = new Map<string, string>(); d.sections.forEach((s) => s.antibiotics.forEach((a) => legend.set(a.code, a.name)));
    if (legend.size) {
      if (doc.y + 30 > bottom()) doc.addPage(); else doc.moveDown(0.6);
      doc.font('R').fontSize(6.5).fillColor('#555').text([...legend.entries()].sort().map(([k, v]) => `${k} — ${v}`).join(' · '), L, doc.y, { width: W });
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0;
      const y = doc.page.height - 22;
      doc.font('R').fontSize(6.5).fillColor('#888').text('კუმულაციური ანტიბიოგრამა (CLSI M39) · აგრეგირებული მონაცემები, პაციენტის მონაცემების გარეშე', L, y, { width: W - 60, lineBreak: false });
      doc.text(`${i - range.start + 1} / ${range.count}`, L + W - 50, y, { width: 50, align: 'right', lineBreak: false });
    }
    doc.end();
    return done;
  }
}

@Controller('ipc/abg')
export class IpcAbgController {
  constructor(private readonly s: IpcAbgService) {}
  @Get('meta') @Roles(...IPC_ANY, 'admin') meta() { return this.s.meta(); }
  @Get('current') @Roles(...IPC_ANY) current(@CurrentUser() u: AuthUser, @Query() q: AbgQuery) { return this.s.current(u, q); }
  @Post('publish') @HttpCode(201) @Roles(...IPC_FULL) publish(@CurrentUser() u: AuthUser, @Body() d: PublishDto, @Req() r: Request) { return this.s.publish(u, d, r); }
  @Get('published') @Roles(...IPC_STATUS_READ) published(@CurrentUser() u: AuthUser, @Query('all') all?: string) { return this.s.published(u, all === '1'); }
  @Get('published/:id') @Roles(...IPC_STATUS_READ) one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.s.one(u, id); }
  @Post('published/:id/withdraw') @HttpCode(200) @Roles(...IPC_FULL)
  withdraw(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: WithdrawDto, @Req() r: Request) { return this.s.withdraw(u, id, d, r); }
  @Get('export') @Roles(...IPC_STATUS_READ)
  async export(@CurrentUser() u: AuthUser, @Query() q: AbgQuery, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}
