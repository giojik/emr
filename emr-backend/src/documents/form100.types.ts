/** ფორმა №IV-100/ა — ცნობის შიგთავსი (ინახება generated_documents.payload-ში, უცვლელად) */
export interface DxItem { code: string; title: string }

export interface Form100Payload {
  form: 'IV-100/a';
  number: string;
  issued_at: string;                         // ISO
  institution: { name: string; address: string; phone: string | null; email: string | null };   // პ.1
  recipient: string;                         // პ.2
  patient: {
    full_name: string;                       // პ.3
    birth_date: string;                      // პ.4 (YYYY-MM-DD)
    personal_number: string | null;          // პ.5 — მხოლოდ 16 წლიდან
    passport_number: string | null;
    address: string | null;                  // პ.6
    phone: string | null;
  };
  workplace: string | null;                  // პ.7
  dates: { outpatient_visit: string | null; sent_to_hospital: string | null; admitted: string | null; discharged: string | null }; // პ.8
  conclusion: 'healthy' | 'practically_healthy' | null;   // პ.9 (ან დიაგნოზი)
  diagnosis: { primary: DxItem[]; secondary: DxItem[]; complications: DxItem[]; note: string | null };
  past_diseases: string | null;              // პ.10
  anamnesis: string | null;                  // პ.11
  investigations: string | null;             // პ.12
  course: 'acute' | 'subacute' | 'chronic' | 'recurrent' | null;   // პ.13
  treatment: string | null;                  // პ.14
  state_on_referral: string | null;          // პ.15
  state_on_discharge: string | null;         // პ.16
  recommendations: string | null;            // პ.17
  doctor: { name: string; specialty: string | null; license_number: string | null };   // პ.18
  director: { name: string; title: string }; // პ.19
  verify_url: string;
}

export const COURSE_KA: Record<NonNullable<Form100Payload['course']>, string> = {
  acute: 'მწვავე', subacute: 'ქვემწვავე', chronic: 'ქრონიკული', recurrent: 'მორეციდივე',
};
export const CONCLUSION_KA: Record<NonNullable<Form100Payload['conclusion']>, string> = {
  healthy: 'ჯანმრთელი', practically_healthy: 'პრაქტიკულად ჯანმრთელი',
};
