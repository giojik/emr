import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { NOTE_FIELDS, KIND_KA } from '../inpatient/notes';
import { StorageService } from '../storage/storage.service';
import { validateBody, type Block } from '../templates/template-blocks';
import { ER_DISPOSITION_KA, fmtDate, fmtDateTime, TemplateContextService } from '../templates/template-context';
import { renderTemplatePdf, type DxItem, type TemplatePdfInput } from '../templates/template.pdf';
import { TemplatesService } from '../templates/templates';
import { erClinicalSettings, type ErClinicalSettings, type SummarySection } from './er-access';

type Trx = Transaction<DB>;
type Ex = Kysely<DB> | Trx;
const TZ = loadEnv().CLINIC_TZ;
const hm = (v: string | Date | null | undefined) => (v ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v)) : '—');
/** შრიფტში არ არის (≥ / ≤ / →) — PDF-ში ASCII-ით */
const pdfSafe = (x: string) => x.replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->');
const TYPE_KA: Record<string, string> = { stat: 'STAT', once: 'ერთჯერადი', prn: 'PRN' };
const OUTCOME_KA: Record<string, string> = { given: 'მიცემულია', partial: 'ნაწილობრივ', held: 'გადადებულია', refused: 'უარი' };
const TRANSPORT_KA: Record<string, string> = { own: 'საკუთარი', ambulance: 'სასწრაფო', clinic_transport: 'კლინიკის ტრანსპორტი', other: 'სხვა' };
const SECTION_LABEL: Record<SummarySection, string> = {
  arrival: 'შემოსვლა', triage: 'ტრიაჟი / ვიტალური ნიშნები', notes: 'ექიმის ჩანაწერები', diagnoses: 'დიაგნოზი (ICD-10)', lab: 'ლაბორატორიული კვლევები',
  dx: 'ინსტრუმენტული კვლევები', consults: 'კონსულტაციები', orders: 'ჩატარებული მკურნალობა / მანიპულაციები', disposition: 'გამოსავალი', recommendations: 'რეკომენდაციები',
};

/**
 * ER-ის ფურცელი (ამონაწერი გადაუდებელი განყოფილებიდან), 0090.
 *  • summary_mode = builtin — ბლოკები კოდში, summary_sections-ის რიგით / შემადგენლობით;
 *    template — ადმინის მიერ რედაქტირებადი შაბლონი ER_SUMMARY (kind er_summary; გამოქვეყნებული ვერსია; არასწორზე — builtin).
 *  • ორივე რეჟიმი — ერთი რენდერი (renderTemplatePdf, ბლოკი er_section) → generated_documents (ERS26-…, QR).
 */
@Injectable()
export class ErSummaryService {
  private readonly env = loadEnv();
  constructor(@InjectDb() private readonly db: Database, private readonly vars: TemplateContextService, private readonly tpl: TemplatesService,
              private readonly storage: StorageService) {}

  /** ბლოკები რეჟიმის მიხედვით */
  async blocks(s: ErClinicalSettings, ex: Ex = this.db): Promise<{ blocks: Block[]; mode: 'builtin' | 'template'; version: number | null }> {
    if (s.summary_mode === 'template') {
      const t = await this.tpl.published('ER_SUMMARY', { activeOnly: true, kinds: ['er_summary'] }).catch(() => null);
      if (t && !validateBody('er_summary', t.body).structural.length) return { blocks: t.body.blocks, mode: 'template', version: t.version };
    }
    void ex;
    const out: Block[] = [{ type: 'header' }, { type: 'heading', text: 'ამონაწერი გადაუდებელი განყოფილებიდან' }, { type: 'patient' }];
    for (const k of s.summary_sections) {
      const label = SECTION_LABEL[k];
      if (k === 'diagnoses') out.push({ type: 'diagnoses', which: 'final', label });
      else if (k === 'lab') out.push({ type: 'lab_results', label });
      else if (k === 'dx') out.push({ type: 'dx_results', label });
      else if (k === 'recommendations') out.push({ type: 'field', key: 'recommendations', label, required: false });
      else out.push({ type: 'er_section', section: k, label });
    }
    out.push({ type: 'signatures', signers: ['attending'] });
    return { blocks: out, mode: 'builtin', version: null };
  }

  /** PDF-ის მონაცემები (ex — გამოსავლის ტრანზაქცია: ახლად ჩაწერილი გამოსავალი ჩანს) */
  async input(encounterId: string, u: Pick<AuthUser, 'name'> | null, ex: Ex, extra: { number?: string; verifyUrl?: string; watermark?: string | null }) {
    const v = await ex.selectFrom('er_visits as v').innerJoin('er_arrival_modes as am', 'am.code', 'v.arrival_mode').leftJoin('external_institutions as ei', 'ei.id', 'v.referral_institution_id')
      .select(['v.encounter_id', 'v.patient_id', 'v.visit_no', 'v.arrived_at', 'v.ended_at', 'v.status', 'v.chief_complaint', 'v.ambulance_crew', 'v.arrival_note', 'am.name as arrival_name',
        'ei.name as referral_name', 'v.doctor_id'])
      .where('v.encounter_id', '=', encounterId).executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    const s = await erClinicalSettings();
    const [vars, clinic, b, disp] = await Promise.all([
      this.vars.resolve(v.patient_id, encounterId, u, ex),
      ex.selectFrom('clinic_settings').select(['name', 'address', 'phone']).where('id', '=', 1).executeTakeFirst(),
      this.blocks(s, ex),
      ex.selectFrom('er_dispositions as x').leftJoin('external_institutions as ei', 'ei.id', 'x.destination_id').leftJoin('users as d', 'd.id', 'x.decided_by')
        .leftJoin('encounters as ie', 'ie.id', 'x.inpatient_encounter_id').leftJoin('departments as idp', 'idp.id', 'ie.department_id')
        .leftJoin('inpatient_stays as st', 'st.encounter_id', 'x.inpatient_encounter_id')
        .selectAll('x').select(['ei.name as destination_name', 'idp.name as admit_department', 'st.adm_no', sql<string | null>`d.first_name || ' ' || d.last_name`.as('decided_by_name'),
          'd.specialty as decided_by_specialty'])
        .where('x.encounter_id', '=', encounterId).where('x.reopened_at', 'is', null).executeTakeFirst(),
    ]);
    const [triage, notes, consults, orders, adms, dxRows, lab, dx] = await Promise.all([
      ex.selectFrom('er_triage as t').leftJoin('encounter_vitals as ev', 'ev.id', 't.vitals_id').innerJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 't.scale_code').onRef('l.level', '=', 't.level'))
        .select(['t.recorded_at', 't.scale_code', 't.level', 'l.name as level_name', 't.is_retriage', 't.news2_score', 't.gcs', 't.discriminator', 'ev.systolic_bp', 'ev.diastolic_bp', 'ev.heart_rate',
          'ev.respiratory_rate', 'ev.temperature', 'ev.spo2', 'ev.o2_supplement'])
        .where('t.encounter_id', '=', encounterId).orderBy('t.recorded_at').execute(),
      ex.selectFrom('doctor_notes as n').innerJoin('users as a', 'a.id', 'n.author_id')
        .select(['n.kind', 'n.content', 'n.signed_at', sql<string>`a.first_name || ' ' || a.last_name`.as('author')])
        .where('n.encounter_id', '=', encounterId).where('n.kind', 'in', ['er_initial', 'er_progress']).where('n.status', '=', 'signed').where('n.superseded_at', 'is', null)
        .orderBy('n.signed_at').execute(),
      ex.selectFrom('consultations as c').leftJoin('departments as d', 'd.id', 'c.target_department_id').leftJoin('users as td', 'td.id', 'c.target_doctor_id')
        .leftJoin('doctor_notes as n', (j) => j.onRef('n.consultation_id', '=', 'c.id').on('n.status', '=', 'signed').on('n.superseded_at', 'is', null))
        .select(['c.status', 'c.question', 'c.answered_at', 'c.created_at', 'd.name as dep', sql<string | null>`td.first_name || ' ' || td.last_name`.as('doctor'), 'n.content'])
        .where('c.encounter_id', '=', encounterId).where('c.status', '<>', 'cancelled').orderBy('c.created_at').execute(),
      ex.selectFrom('er_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id').leftJoin('med_routes as r', 'r.code', 'o.route_code')
        .select(['o.id', 'o.kind', 'o.order_type', 'o.drug_text', 'o.text', 'o.dose', 'o.dose_unit', 'o.rate_ml_h', 'o.status', 'o.stop_reason', 'g.inn', 'g.strength', 'r.name as route_name'])
        .where('o.encounter_id', '=', encounterId).orderBy('o.created_at').execute(),
      ex.selectFrom('er_administrations').select(['order_id', 'outcome', 'administered_at', 'dose', 'infusion_action', 'reason'])
        .where('encounter_id', '=', encounterId).where('voided_at', 'is', null).orderBy('administered_at').execute(),
      ex.selectFrom('encounter_diagnoses').select(['icd10_code', 'icd10_title', 'diagnosis_type']).where('encounter_id', '=', encounterId).orderBy('created_at').execute(),
      ex.selectFrom('lab_results as r').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id').innerJoin('lab_analytes as a', 'a.id', 'r.analyte_id')
        .select(['a.name as test', 'r.value_num', 'r.value_text', 'r.unit', 'r.ref_low', 'r.ref_high', 'r.ref_text', 'r.flag', sql<Date>`coalesce(i.validated_at, i.resulted_at, r.entered_at)`.as('at')])
        .where('i.encounter_id', '=', encounterId).where('i.section', '=', 'lab').where('i.validated_at', 'is not', null)
        .where((eb) => eb.or([eb('r.value_num', 'is not', null), eb('r.value_text', 'is not', null)])).orderBy(sql`coalesce(i.validated_at, i.resulted_at, r.entered_at)`).orderBy('a.name').execute(),
      ex.selectFrom('dx_order_items as i').innerJoin('dx_services as sv', 'sv.id', 'i.service_id')
        .innerJoin('dx_reports as rep', (j) => j.onRef('rep.order_item_id', '=', 'i.id').on('rep.status', '=', 'signed'))
        .select(['sv.name as title', 'rep.signed_at as at', 'rep.impression as conclusion'])
        .where('i.encounter_id', '=', encounterId).where('i.section', 'in', ['radiology', 'endoscopy']).orderBy('rep.signed_at').execute(),
    ]);

    const vit = (t: (typeof triage)[number]) => [t.systolic_bp && `წნ. ${t.systolic_bp}/${t.diastolic_bp ?? '—'}`, t.heart_rate && `HR ${t.heart_rate}`, t.respiratory_rate && `RR ${t.respiratory_rate}`,
      t.spo2 && `SpO₂ ${t.spo2}%${t.o2_supplement ? ' (O₂)' : ''}`, t.temperature && `T ${t.temperature}°`, t.gcs && `GCS ${t.gcs}`, t.news2_score !== null && `NEWS2 ${t.news2_score}`].filter(Boolean).join(', ');
    const noteText = (n: (typeof notes)[number]) => {
      const c = (n.content ?? {}) as Record<string, string>;
      const fields = NOTE_FIELDS[n.kind as keyof typeof NOTE_FIELDS] ?? [];
      const body = fields.filter((f) => c[f.key]?.trim()).map((f) => `${f.label}: ${c[f.key].trim()}`).join('\n');
      return `${KIND_KA[n.kind as keyof typeof KIND_KA] ?? n.kind} (${fmtDateTime(n.signed_at)}, ${n.author}):\n${body || '—'}`;
    };
    const orderLabel = (o: (typeof orders)[number]) => o.kind === 'procedure' ? `პროცედურა: ${o.text}` :
      `${o.inn ? `${o.inn}${o.strength ? ` ${o.strength}` : ''}` : o.drug_text}${o.dose ? ` ${Number(o.dose)} ${o.dose_unit ?? ''}` : ''}${o.route_name ? `, ${o.route_name}` : ''}${o.rate_ml_h ? `, ${Number(o.rate_ml_h)} მლ/სთ` : ''}`;
    const orderText = orders.map((o) => {
      const a = adms.filter((x) => x.order_id === o.id).map((x) => `${hm(x.administered_at)} ${x.infusion_action === 'start' ? 'დაწყება' : x.infusion_action === 'stop' ? 'დასრულება' : OUTCOME_KA[x.outcome]}${x.reason ? ` (${x.reason})` : ''}`);
      const st = o.status === 'stopped' && o.stop_reason?.startsWith('გადატანილია') ? ' — გადატანილია სტაციონარში' : o.status === 'stopped' && !a.length ? ' — შეწყდა' : '';
      return `${TYPE_KA[o.order_type] ?? o.order_type} · ${orderLabel(o)}${a.length ? `: ${a.join('; ')}` : ' — არ შესრულებულა'}${st}`;
    }).join('\n');
    const pick = (t: string): DxItem[] => dxRows.filter((d) => d.diagnosis_type === t).map((d) => ({ code: d.icd10_code, title: d.icd10_title }));
    let dispText: string | null = null;
    if (disp) {
      const parts = [`${ER_DISPOSITION_KA[disp.kind]} — ${fmtDateTime(disp.departed_at)}`];
      if (disp.kind === 'admitted') parts.push(`განყოფილება: ${disp.admit_department ?? '—'}${disp.adm_no ? ` (${disp.adm_no})` : ''}`);
      if (disp.kind === 'transfer') {
        parts.push(`დაწესებულება: ${disp.destination_name ?? disp.destination_text}`, `მიზეზი: ${disp.transfer_reason}`);
        if (disp.transport) parts.push(`ტრანსპორტი: ${TRANSPORT_KA[disp.transport] ?? disp.transport}`);
        if (disp.receiver) parts.push(`მიმღები: ${disp.receiver}`);
      }
      if (disp.kind === 'ama') parts.push(disp.refusal_consent_id ? 'ხელწერილი — ხელმოწერილია' : disp.refusal_witnesses?.length ? `ხელმოწერაზე უარი — ${disp.refusal_witnesses.length} მოწმე` : `მიზეზი: ${disp.ama_reason ?? '—'}`);
      if (disp.kind === 'death') parts.push(`გარდაცვალების დრო: ${fmtDateTime(disp.death_at)}`, `მიზეზი: ${disp.death_icd10_code} — ${disp.death_icd10_title}`,
        `აუტოფსია: ${disp.autopsy_required ? 'საჭიროა' : 'არ არის საჭირო'}`, ...(disp.dead_on_arrival ? ['შემოყვანილია გარდაცვლილი'] : []));
      if (disp.note) parts.push(`შენიშვნა: ${disp.note}`);
      dispText = parts.join('\n');
    }
    const ref = (r: (typeof lab)[number]) => r.ref_text ?? (r.ref_low != null || r.ref_high != null ? `${r.ref_low ?? ''}–${r.ref_high ?? ''}` : null);
    const input: TemplatePdfInput = {
      clinic: clinic ?? { name: vars['clinic.name'] || 'კლინიკა', address: vars['clinic.address'] || '', phone: null },
      title: 'ER-ის ფურცელი', number: extra.number ?? null, verifyUrl: extra.verifyUrl ?? null, watermark: extra.watermark ?? null, vars, blocks: b.blocks,
      footer: `ER ${v.visit_no}`,
      data: {
        patient: { full_name: vars['patient.full_name'], birth_date: vars['patient.birth_date'], id_number: vars['patient.id_number'], address: vars['patient.address'], phone: vars['patient.phone'] },
        diagnoses: { admission: pick('admission'), final: { primary: pick('primary'), secondary: pick('secondary'), complication: pick('complication') } },
        fields: { recommendations: disp?.recommendations ?? null, note: disp?.note ?? null },
        lab: lab.map((r) => ({ date: `${fmtDate(r.at)} ${hm(r.at)}`, test: r.test, value: String(r.value_num ?? r.value_text ?? ''), unit: r.unit || null, ref: ref(r), flag: r.flag && r.flag !== 'N' ? r.flag : null })),
        dx: dx.map((r) => ({ date: fmtDate(r.at)!, title: r.title, conclusion: r.conclusion })),
        signatures: { attending: disp ? { name: disp.decided_by_name ?? '', role: disp.decided_by_specialty, at: fmtDateTime(disp.decided_at) } : { name: vars['er.doctor'] } },
        er: {
          arrival: `${fmtDateTime(v.arrived_at)} — ${v.arrival_name}${v.ambulance_crew ? ` (ბრიგ. №${v.ambulance_crew})` : ''}${v.referral_name ? `, ${v.referral_name}` : ''}\nჩივილი: ${v.chief_complaint}${v.arrival_note ? `\n${v.arrival_note}` : ''}`,
          triage: triage.length ? triage.map((t) => `${hm(t.recorded_at)} — ${pdfSafe(t.level_name.startsWith(`${t.scale_code} ${t.level}`) ? t.level_name : `${t.scale_code} ${t.level} (${t.level_name})`)}${t.is_retriage ? ', განმეორებითი' : ''}${vit(t) ? `; ${vit(t)}` : ''}${t.discriminator ? `; ${t.discriminator}` : ''}`).join('\n') : null,
          notes: notes.length ? notes.map(noteText).join('\n\n') : null,
          consults: consults.length ? consults.map((c) => {
            const ans = c.content ? Object.values(c.content as Record<string, string>).filter((x) => x?.trim()).join(' / ') : '';
            return `${c.dep ?? c.doctor ?? '—'} (${fmtDateTime(c.created_at)}): ${c.question}${c.status === 'answered' ? `\nპასუხი (${fmtDateTime(c.answered_at)}): ${ans || '—'}` : ' — პასუხის გარეშე'}`;
          }).join('\n') : null,
          orders: orderText || null,
          disposition: dispText,
        },
      },
    };
    return { input, visit: v, disp, mode: b.mode, version: b.version };
  }

  preview(encounterId: string, u: AuthUser) {
    return this.input(encounterId, u, this.db, { watermark: 'პროექტი' }).then((r) => renderTemplatePdf(r.input));
  }

  /** გაცემა (გამოსავლისას ან განახლებისას — დოკუმენტაციის ფანჯარაში); წინა ფურცელი → revoked */
  async issue(trx: Trx, encounterId: string, u: AuthUser, nextNo: (trx: Trx, type: string, prefix: string) => Promise<string>, revokeReason?: string) {
    const prev = await trx.selectFrom('er_dispositions').select(['id', 'summary_document_id']).where('encounter_id', '=', encounterId).where('reopened_at', 'is', null).forUpdate().executeTakeFirst();
    if (!prev) throw new ConflictException('გამოსავალი ჯერ არ არის გაფორმებული');
    const number = await nextNo(trx, 'er_summary', 'ERS');
    const token = randomUUID();
    const verifyUrl = `${this.env.PUBLIC_VERIFY_BASE_URL.replace(/\/$/, '')}/${token}`;
    const r = await this.input(encounterId, u, trx, { number, verifyUrl });
    const pdf = await renderTemplatePdf(r.input);
    const sha = createHash('sha256').update(pdf).digest('hex');
    const now = new Date();
    const key = `documents/er-summary/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${token}.pdf`;
    await this.storage.put(key, pdf, 'application/pdf');
    const payload = {
      form: 'er_summary', number, issued_at: now.toISOString(), mode: r.mode, template_version: r.version,
      institution: { name: r.input.clinic.name }, patient: { full_name: r.input.data.patient.full_name },
      er: { visit_no: r.visit.visit_no, arrived_at: r.visit.arrived_at, departed_at: r.disp?.departed_at ?? null, disposition: r.disp?.kind ?? null }, verify_url: verifyUrl,
    };
    const doc = await trx.insertInto('generated_documents').values({
      encounter_id: encounterId, document_type: 'er_summary', file_path: key, verification_token: token, generated_by: u.id,
      document_number: number, payload: JSON.stringify(payload), file_sha256: sha,
    }).returning(['id']).executeTakeFirstOrThrow();
    if (prev.summary_document_id) {
      await trx.updateTable('generated_documents').set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: u.id, revoke_reason: revokeReason ?? 'ER-ის ფურცელი განახლდა' })
        .where('id', '=', prev.summary_document_id).where('status', '=', 'issued').execute();
    }
    await trx.updateTable('er_dispositions').set({ summary_document_id: doc.id }).where('id', '=', prev.id).execute();
    return { id: doc.id, number };
  }

  async file(encounterId: string) {
    const d = await this.db.selectFrom('er_dispositions as x').innerJoin('generated_documents as g', 'g.id', 'x.summary_document_id')
      .select(['g.file_path', 'g.document_number', 'g.id']).where('x.encounter_id', '=', encounterId).where('x.reopened_at', 'is', null).executeTakeFirst();
    if (!d) throw new NotFoundException('ER-ის ფურცელი ჯერ არ არის გაცემული');
    return { id: d.id, number: d.document_number, stream: await this.storage.get(d.file_path) };
  }
}
