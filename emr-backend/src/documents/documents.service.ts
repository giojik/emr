import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { StorageService } from '../storage/storage.service';
import { renderForm100 } from './form100.pdf';
import type { DxItem, Form100Payload } from './form100.types';
import type { IssueForm100Dto } from './documents.dto';

const REFERRAL_KA: Record<string, string> = {
  lab: 'ლაბორატორიული კვლევა', imaging: 'რადიოლოგიური კვლევა', hospitalization: 'ჰოსპიტალიზაცია', specialist_consult: 'სპეციალისტის კონსულტაცია',
};

/** სრული წლების რაოდენობა თარიღზე */
function ageOn(birth: string, on: Date) {
  const [y, m, d] = birth.split('-').map(Number);
  let age = on.getFullYear() - y;
  if (on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d)) age--;
  return age;
}

@Injectable()
export class DocumentsService {
  private readonly env = loadEnv();
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly settings: ClinicSettingsService, private readonly storage: StorageService) {}

  /**
   * ცნობის მონახაზი: EMR-დან ავტომატურად შევსებული ველები. არაფერს ინახავს —
   * ექიმი ეკრანზე ასწორებს და ასრულებს (issue).
   */
  async draft(encounterId: string) {
    const e = await this.db.selectFrom('encounters as e')
      .innerJoin('patients as p', 'p.id', 'e.patient_id')
      .select(['e.id', 'e.status', 'e.start_time', 'e.end_time', 'e.history_of_present_illness', 'e.attending_doctor_id', 'e.patient_id'])
      .where('e.id', '=', encounterId).executeTakeFirst();
    if (!e) throw new NotFoundException('ვიზიტი ვერ მოიძებნა');

    const [dxRows, chronic, refs, rx, dxItems] = await Promise.all([
      this.db.selectFrom('encounter_diagnoses').select(['icd10_code', 'icd10_title', 'diagnosis_type'])
        .where('encounter_id', '=', encounterId).orderBy('created_at').execute(),
      this.db.selectFrom('patient_chronic_conditions').select(['icd10_code', 'condition_name'])
        .where('patient_id', '=', e.patient_id).where('is_active', '=', true).execute(),
      this.db.selectFrom('referrals').select(['type', 'reason', 'result_text', 'completed_at'])
        .where('encounter_id', '=', encounterId).where('status', '=', 'completed').orderBy('completed_at').execute(),
      this.db.selectFrom('prescriptions').select(['medication_name', 'dosage', 'route', 'frequency', 'duration_days'])
        .where('encounter_id', '=', encounterId).orderBy('created_at').execute(),
      this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id')
        .select(['i.id', 'i.section', 's.name', 'i.report_text',
          (eb) => jsonArrayFrom(eb.selectFrom('lab_results as r').innerJoin('lab_analytes as a', 'a.id', 'r.analyte_id')
            .select(['a.name', 'r.value_num', 'r.value_text', 'r.unit', 'r.flag']).whereRef('r.order_item_id', '=', 'i.id').orderBy('a.sort_order')).as('results')])
        .where('i.encounter_id', '=', encounterId).where('i.status', '=', 'validated').orderBy('i.ordered_at').execute(),
    ]);
    // დიაგნოსტიკა: ლაბორატორია — მხოლოდ გადახრები (დანარჩენი "ნორმის ფარგლებში"); რადიოლოგია/ენდოსკოპია — დასკვნა
    const arrow: Record<string, string> = { L: '(დაბ.)', H: '(მაღ.)', LL: '(კრიტ. დაბ.)', HH: '(კრიტ. მაღ.)', A: '(გადახრა)' };
    const dxLines = dxItems.map((i) => {
      if (i.section !== 'lab') return `${i.name}: ${i.report_text ?? ''}`;
      const abn = i.results.filter((r) => r.flag && r.flag !== 'N');
      return `${i.name}: ${abn.length ? abn.map((r) => `${r.name} ${r.value_num !== null ? Number(r.value_num) : r.value_text}${r.unit ? ` ${r.unit}` : ''} ${arrow[r.flag!] ?? ''}`.trim()).join('; ') : 'ნორმის ფარგლებში'}`;
    });
    const pick = (t: string): DxItem[] => dxRows.filter((d) => d.diagnosis_type === t).map((d) => ({ code: d.icd10_code, title: d.icd10_title }));

    return {
      encounter_status: e.status,
      recipient: 'მოთხოვნის ადგილზე წარსადგენად',
      workplace: null as string | null,
      conclusion: null as Form100Payload['conclusion'],
      diagnosis: { primary: pick('primary'), secondary: pick('secondary'), complications: pick('complication') },
      diagnosis_note: null as string | null,
      past_diseases: chronic.map((c) => (c.icd10_code ? `${c.condition_name} (${c.icd10_code})` : c.condition_name)).join('; ') || null,
      anamnesis: e.history_of_present_illness,
      investigations: [...dxLines, ...refs.map((r) => `${REFERRAL_KA[r.type] ?? r.type} — ${r.reason}${r.result_text ? `: ${r.result_text}` : ''}`)].join('\n') || null,
      course: null as Form100Payload['course'],
      treatment: rx.map((r) => `${r.medication_name} ${r.dosage}, ${r.frequency}${r.duration_days ? `, ${r.duration_days} დღე` : ''}`).join('; ') || null,
      recommendations: null as string | null,
    };
  }

  /** გაცემა: ნომერი ჟურნალში → PDF (QR-ით) → საცავი → ჩანაწერი. ერთ ტრანზაქციაში (ფაილი ჯერ საცავში, მერე DB). */
  async issueForm100(encounterId: string, dto: IssueForm100Dto, user: AuthUser, ctx: AuditContext) {
    const clinic = await this.settings.get();
    const d = await this.draft(encounterId);

    return this.db.transaction().execute(async (trx) => {
      const e = await trx.selectFrom('encounters as e')
        .innerJoin('patients as p', 'p.id', 'e.patient_id')
        .innerJoin('users as u', 'u.id', 'e.attending_doctor_id')
        .select(['e.id', 'e.status', 'e.start_time', 'e.attending_doctor_id',
          'p.first_name', 'p.last_name', 'p.birth_date', 'p.personal_number', 'p.passport_number', 'p.address', 'p.phone_number',
          'u.first_name as doc_first', 'u.last_name as doc_last', 'u.specialty', 'u.license_number'])
        .where('e.id', '=', encounterId).forUpdate(['e']).executeTakeFirstOrThrow();

      if (!['active', 'discharged'].includes(e.status)) throw new ConflictException(`ცნობა ვერ გაიცემა ვიზიტის სტატუსზე "${e.status}"`);
      if (!(user.role === 'admin' || (user.role === 'doctor' && user.id === e.attending_doctor_id))) {
        throw new ForbiddenException('ცნობას გასცემს მკურნალი ექიმი');
      }
      const conclusion = dto.conclusion ?? null;
      if (!conclusion && d.diagnosis.primary.length === 0) {
        throw new BadRequestException({ code: 'DIAGNOSIS_OR_CONCLUSION_REQUIRED',
          message: 'მე-9 პუნქტი: საჭიროა ძირითადი დიაგნოზი ან დასკვნა ("ჯანმრთელი"/"პრაქტიკულად ჯანმრთელი")' });
      }

      const now = new Date();
      // უწყვეტი ნუმერაცია: მრიცხველი იბლოკება ამ ტრანზაქციის ბოლომდე; შეცდომისას rollback — ნომერი არ იკარგება
      const { last_value: seq } = await trx.insertInto('document_counters')
        .values({ document_type: 'form_100', year: now.getFullYear(), last_value: 1 })
        .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
        .returning('last_value').executeTakeFirstOrThrow();
      const number = `100/ა-${now.getFullYear()}-${String(seq).padStart(6, '0')}`;
      const token = randomUUID();

      const payload: Form100Payload = {
        form: 'IV-100/a', number, issued_at: now.toISOString(),
        institution: { name: clinic.name, address: clinic.address, phone: clinic.phone, email: clinic.email },
        recipient: dto.recipient ?? d.recipient,
        patient: {
          full_name: `${e.first_name} ${e.last_name}`, birth_date: e.birth_date,
          personal_number: ageOn(e.birth_date, now) >= 16 ? e.personal_number : null,
          passport_number: e.personal_number ? null : e.passport_number,
          address: e.address, phone: e.phone_number,
        },
        workplace: dto.workplace ?? null,
        dates: { outpatient_visit: e.start_time.toISOString().slice(0, 10), sent_to_hospital: null, admitted: null, discharged: null },
        conclusion,
        diagnosis: { ...d.diagnosis, note: dto.diagnosis_note ?? null },
        past_diseases: dto.past_diseases !== undefined ? dto.past_diseases : d.past_diseases,
        anamnesis: dto.anamnesis !== undefined ? dto.anamnesis : d.anamnesis,
        investigations: dto.investigations !== undefined ? dto.investigations : d.investigations,
        course: dto.course ?? null,
        treatment: dto.treatment !== undefined ? dto.treatment : d.treatment,
        state_on_referral: null, state_on_discharge: null,
        recommendations: dto.recommendations ?? null,
        doctor: { name: `${e.doc_first} ${e.doc_last}`, specialty: e.specialty, license_number: e.license_number },
        director: { name: clinic.director_name, title: clinic.director_title },
        verify_url: `${this.env.PUBLIC_VERIFY_BASE_URL.replace(/\/$/, '')}/${token}`,
      };

      const pdf = await renderForm100(payload);
      const sha = createHash('sha256').update(pdf).digest('hex');
      const key = `documents/form_100/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${token}.pdf`;
      await this.storage.put(key, pdf, 'application/pdf');

      const doc = await trx.insertInto('generated_documents').values({
        encounter_id: encounterId, document_type: 'form_100', file_path: key, verification_token: token,
        generated_by: user.id, document_number: number, payload: JSON.stringify(payload), file_sha256: sha,
      }).returning(['id', 'document_number', 'verification_token', 'generated_at']).executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ISSUE_FORM_100', entityName: 'generated_documents', entityId: doc.id,
        newData: { number, encounter_id: encounterId, sha256: sha } }, trx);
      return { ...doc, verify_url: payload.verify_url, file_sha256: sha };
    });
  }

  /** ჟურნალი (ბრძანება №338/ნ, მუხ. 2.3 — აღრიცხვა რიგითი ნომრით) */
  list(q: { type?: string; encounterId?: string; patientId?: string; from?: string; to?: string }) {
    let query = this.db.selectFrom('generated_documents as g')
      .innerJoin('encounters as e', 'e.id', 'g.encounter_id')
      .innerJoin('patients as p', 'p.id', 'e.patient_id')
      .leftJoin('users as u', 'u.id', 'g.generated_by')
      .select(['g.id', 'g.document_type', 'g.document_number', 'g.status', 'g.generated_at', 'g.revoked_at', 'g.revoke_reason',
        'g.encounter_id', 'e.patient_id', 'p.first_name as patient_first_name', 'p.last_name as patient_last_name', 'p.personal_number',
        sql<string>`u.first_name || ' ' || u.last_name`.as('issued_by')])
      .orderBy('g.generated_at', 'desc').limit(500);
    if (q.type) query = query.where('g.document_type', '=', q.type);
    if (q.encounterId) query = query.where('g.encounter_id', '=', q.encounterId);
    if (q.patientId) query = query.where('e.patient_id', '=', q.patientId);
    if (q.from) query = query.where('g.generated_at', '>=', new Date(q.from));
    if (q.to) query = query.where('g.generated_at', '<', new Date(q.to));
    return query.execute();
  }

  async get(id: string) {
    const d = await this.db.selectFrom('generated_documents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
    return d;
  }

  async pdf(id: string, ctx: AuditContext) {
    const d = await this.get(id);
    await this.audit.log(ctx, { action: 'DOWNLOAD_DOCUMENT', entityName: 'generated_documents', entityId: id });
    return { stream: await this.storage.get(d.file_path), filename: `${(d.document_number ?? d.id).replace(/[^\w.-]+/g, '_')}.pdf`, status: d.status };
  }

  /** გაუქმება (შეცდომით გაცემული) — ფაილი და ჩანაწერი რჩება, QR ვერიფიკაცია აჩვენებს "გაუქმებულს" */
  async revoke(id: string, reason: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('generated_documents').select(['id', 'status', 'generated_by']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
      if (d.status === 'revoked') throw new ConflictException('დოკუმენტი უკვე გაუქმებულია');
      if (!(user.role === 'admin' || user.id === d.generated_by)) throw new ForbiddenException('გაუქმება შეუძლია გამცემ ექიმს ან ადმინისტრატორს');
      await trx.updateTable('generated_documents').set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: user.id, revoke_reason: reason })
        .where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'REVOKE_DOCUMENT', entityName: 'generated_documents', entityId: id, newData: { reason } }, trx);
      return { id, status: 'revoked' };
    });
  }

  /** საჯარო ვერიფიკაცია — მინიმალური ინფორმაცია, პაციენტის პერსონალური მონაცემების გარეშე (მხოლოდ ინიციალები) */
  async verify(token: string) {
    const d = await this.db.selectFrom('generated_documents')
      .select(['document_type', 'document_number', 'status', 'generated_at', 'revoked_at', 'file_sha256', 'payload'])
      .where('verification_token', '=', token).executeTakeFirst();
    if (!d) return { valid: false as const, reason: 'not_found' };
    const p = d.payload as unknown as Form100Payload;
    const initials = (p.patient?.full_name ?? '').split(/\s+/).filter(Boolean).map((w) => `${w[0]}.`).join(' ');
    return {
      valid: d.status === 'issued',
      status: d.status,
      document_type: d.document_type === 'form_100' ? 'ფორმა №IV-100/ა — ცნობა ჯანმრთელობის მდგომარეობის შესახებ' : d.document_type,
      document_number: d.document_number,
      issued_at: d.generated_at,
      revoked_at: d.revoked_at,
      institution: p.institution?.name ?? null,
      patient_initials: initials,
      file_sha256: d.file_sha256,
    };
  }
}
