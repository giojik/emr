import { ApiError } from '../../api/client';
import type { DxItem } from '../../api/types';
import { age, dateGe, genderShort, hhmm, tsDate } from '../../lib/format';

export const IONIZING = ['CT', 'DX', 'RF', 'MG', 'DXA'];
export const BLANK = '___';

/** ქალი 12–55 წ + მაიონებელი გამოსხივება → ორსულობის კითხვა სავალდებულოა */
export const needsPregnancy = (it: Pick<DxItem, 'modality' | 'gender' | 'birth_date'>) => {
  const a = age(it.birth_date);
  return IONIZING.includes(it.modality ?? '') && it.gender === 'female' && a >= 12 && a <= 55;
};

export const CONTRAST_KA: Record<string, string> = { iodinated: 'იოდშემცველი', gadolinium: 'გადოლინიუმი', barium: 'ბარიუმი' };
export const PREGNANCY_KA: Record<string, string> = { not_pregnant: 'ორსულობა გამორიცხულია', pregnant_approved: 'ორსული — რადიოლოგის თანხმობით' };
export const RENAL_KA: Record<string, string> = { ok: 'თირკმლის ფუნქცია შემოწმებულია', not_checked_approved: 'არ შემოწმებულა — ექიმის თანხმობით' };

/** 409 UNPAID / OUTSIDE_HOURS → დადასტურება და განმეორება */
export const errCode = (e: unknown) => (e instanceof ApiError ? e.code : undefined);

/** შაბლონის ცვლადები: {პაციენტი} {ასაკი} {სქესი} {კვლევა} {თარიღი} {კონტრასტი} */
export function fillPlaceholders(text: string | null, it: DxItem) {
  if (!text) return '';
  const map: Record<string, string> = {
    'პაციენტი': `${it.first_name} ${it.last_name}`, 'ასაკი': `${age(it.birth_date)} წ`, 'სქესი': it.gender === 'male' ? 'მამრობითი' : it.gender === 'female' ? 'მდედრობითი' : '—',
    'კვლევა': it.service_name, 'თარიღი': it.performed_at ? tsDate(it.performed_at) : tsDate(new Date().toISOString()),
    'კონტრასტი': it.contrast_agent ? `${it.contrast_agent}${it.contrast_volume_ml ? `, ${Number(it.contrast_volume_ml)} მლ` : ''}` : 'კონტრასტის გარეშე',
  };
  return text.replace(/\{([^{}]+)\}/g, (m, k: string) => map[k.trim()] ?? m);
}

/** პაციენტის იდენტიფიკაციის ზოლი */
export function PatientLine({ it }: { it: DxItem }) {
  return (
    <span>
      <strong>{it.first_name} {it.last_name}</strong> · {genderShort(it.gender)} · {age(it.birth_date)} წ · დაბ. {dateGe(it.birth_date)}
      {it.personal_number && <> · <span className="mono">{it.personal_number}</span></>}
    </span>
  );
}

export function StudyMeta({ it }: { it: DxItem }) {
  const parts = [
    it.accession_number && <span key="a" className="mono">{it.accession_number}</span>,
    it.scheduled_start && <span key="s">ჩაწერა {tsDate(it.scheduled_start)} {hhmm(it.scheduled_start)}{it.device_name ? ` · ${it.device_name}` : ''}</span>,
    it.performed_at && <span key="p">შესრულდა {tsDate(it.performed_at)} {hhmm(it.performed_at)}</span>,
  ].filter(Boolean);
  return <span className="small muted row" style={{ gap: 10, flexWrap: 'wrap' }}>{parts}</span>;
}

export const Urgent = ({ it }: { it: Pick<DxItem, 'priority'> }) => it.priority === 'urgent' ? <span className="chip danger" style={{ marginLeft: 6 }}>სასწრაფო</span> : null;
export const ContrastChip = ({ it }: { it: Pick<DxItem, 'contrast'> }) => it.contrast ? <span className="chip warn" style={{ marginLeft: 6 }}>{CONTRAST_KA[it.contrast] ?? 'კონტრასტი'}</span> : null;
