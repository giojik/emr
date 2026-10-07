import { Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../database/db';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { AuthUser } from '../auth/roles';

const TZ = loadEnv().CLINIC_TZ;
const GENDER_KA: Record<string, string> = { male: 'მამრობითი', female: 'მდედრობითი', other: 'სხვა' };
export const DISCHARGE_KA: Record<string, string> = {
  home: 'ბინაზე', other_clinic: 'სხვა სამედიცინო დაწესებულებაში', against_advice: 'თვითნებურად (ხელწერილით)', death: 'გარდაცვალება',
};

export const fmtDate = (v: string | Date | null | undefined) => {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-'); return `${d}/${m}/${y}`; }
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(v));
};
export const fmtDateTime = (v: string | Date | null | undefined) => {
  if (!v) return null;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(v));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}`;
};

/**
 * საწოლდღე (census): მიღების დღე ითვლება, გაწერის დღე — არა; ერთ დღეში მიღება-გაწერა = 1.
 * (დროებითი გასვლის დღეები — leave_counts_bed_day = false-ისას აკლდება სრული კალენდარული დღეები გასვლაზე.)
 */
export function bedDaysSql(stay: 'st') {
  return sql<number>`GREATEST(1, ((coalesce(${sql.ref(`${stay}.ended_at`)}, now()) AT TIME ZONE ${TZ})::date - (${sql.ref(`${stay}.admitted_at`)} AT TIME ZONE ${TZ})::date))`;
}

/** შაბლონის ცვლადების მნიშვნელობები სისტემიდან (კატალოგი — template-blocks.ts VARIABLES) */
@Injectable()
export class TemplateContextService {
  constructor(@InjectDb() private readonly db: Database) {}

  /** ex — ტრანზაქცია, როცა ცვლადები იმავე ტრანზაქციაში შეცვლილ მონაცემებს უნდა ხედავდეს (მაგ. ეპიკრიზის ხელმოწერა გაწერისას) */
  async resolve(patientId: string, encounterId: string | null | undefined, user: Pick<AuthUser, 'name'> | null, ex: Kysely<DB> = this.db): Promise<Record<string, string>> {
    const [p, clinic] = await Promise.all([
      ex.selectFrom('patients').select(['first_name', 'last_name', 'birth_date', 'gender', 'personal_number', 'passport_number', 'address', 'phone_number',
        sql<number>`date_part('year', age((now() AT TIME ZONE ${TZ})::date, birth_date))::int`.as('age')]).where('id', '=', patientId).executeTakeFirst(),
      ex.selectFrom('clinic_settings').selectAll().where('id', '=', 1).executeTakeFirst(),
    ]);
    if (!p) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    const v: Record<string, string | null | undefined> = {
      'patient.full_name': `${p.first_name} ${p.last_name}`, 'patient.first_name': p.first_name, 'patient.last_name': p.last_name,
      'patient.birth_date': fmtDate(p.birth_date), 'patient.age': String(p.age), 'patient.gender': GENDER_KA[p.gender] ?? p.gender,
      'patient.personal_number': p.personal_number, 'patient.id_number': p.personal_number ?? (p.passport_number ? `პასპორტი ${p.passport_number}` : null),
      'patient.address': p.address, 'patient.phone': p.phone_number,
      'clinic.name': clinic?.name, 'clinic.address': clinic?.address, 'clinic.phone': clinic?.phone, 'clinic.director': clinic?.director_name,
      'doc.date': fmtDate(new Date()), 'user.name': user?.name,
    };
    if (encounterId) {
      const e = await ex.selectFrom('encounters as e').leftJoin('users as d', 'd.id', 'e.attending_doctor_id')
        .select(['e.start_time', 'e.patient_id', sql<string | null>`d.first_name || ' ' || d.last_name`.as('doctor')]).where('e.id', '=', encounterId).executeTakeFirst();
      if (e && e.patient_id === patientId) {
        v['encounter.date'] = fmtDate(e.start_time);
        v['stay.attending_doctor'] = e.doctor;
        const st = await ex.selectFrom('inpatient_stays as st')
          .select(['st.adm_no', 'st.admitted_at', 'st.ended_at', 'st.status', 'st.discharge_type', bedDaysSql('st').as('bed_days')])
          .where('st.encounter_id', '=', encounterId).executeTakeFirst();
        if (st) {
          // მიმდინარე (ან ბოლო) ეპიზოდი: განყოფილება, პალატა, საწოლი
          const a = await ex.selectFrom('bed_assignments as a').innerJoin('departments as dp', 'dp.id', 'a.department_id')
            .leftJoin('beds as b', 'b.id', 'a.bed_id').leftJoin('wards as w', 'w.id', 'b.ward_id')
            .select(['dp.name as department', 'w.code as ward', 'b.code as bed'])
            .where('a.encounter_id', '=', encounterId).where('a.end_kind', 'is distinct from', 'cancel')
            .orderBy('a.started_at', 'desc').orderBy('a.id', 'desc').limit(1).executeTakeFirst();
          // leave_counts_bed_day = false → აკლდება დროებით გასვლაზე გატარებული შუაღამეები (census)
          const mod = await ex.selectFrom('system_modules').select('settings').where('code', '=', 'inpatient').executeTakeFirst();
          let bedDays = Number(st.bed_days);
          if ((mod?.settings as { leave_counts_bed_day?: boolean } | undefined)?.leave_counts_bed_day === false) {
            const { n } = await ex.selectFrom('inpatient_leaves')
              .select(sql<number>`coalesce(sum(((coalesce(returned_at, now()) AT TIME ZONE ${TZ})::date - (started_at AT TIME ZONE ${TZ})::date)), 0)::int`.as('n'))
              .where('encounter_id', '=', encounterId).executeTakeFirstOrThrow();
            bedDays = Math.max(1, bedDays - n);
          }
          Object.assign(v, {
            'stay.adm_no': st.adm_no, 'stay.department': a?.department, 'stay.ward': a?.ward, 'stay.bed': a?.bed,
            'stay.admitted_at': fmtDateTime(st.admitted_at),
            'stay.discharged_at': st.status === 'discharged' ? fmtDateTime(st.ended_at) : null,
            'stay.discharge_type': st.discharge_type ? DISCHARGE_KA[st.discharge_type] : null,
            'stay.bed_days': String(bedDays),
          });
        }
      }
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? '']));
  }
}
