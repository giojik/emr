import type { Allergy } from '../api/types';
import { SEVERITY_KA } from '../lib/format';
import { WarnIcon } from './ui';

/** ალერგიების ბანერი — ყოველთვის ხილული პაციენტის თავში */
export default function AllergyBanner({ allergies, chronic, onAdd }: { allergies: Allergy[]; chronic?: { icd10_code: string | null; condition_name: string }[]; onAdd?: () => void }) {
  const real = allergies.filter((a) => a.allergy_type !== 'intolerance');
  const intol = allergies.filter((a) => a.allergy_type === 'intolerance');
  const severe = real.some((a) => a.severity === 'severe');
  if (!allergies.length) {
    return (
      <div className="alert info" style={{ alignItems: 'center' }}>
        <span className="grow">ალერგიები არ არის რეგისტრირებული{chronic?.length ? ` · ქრონიკული: ${chronic.map((c) => c.condition_name).join(', ')}` : ''}</span>
        {onAdd && <button className="btn sm" type="button" onClick={onAdd}>+ ალერგია</button>}
      </div>
    );
  }
  return (
    <div className={`alert ${real.length ? 'danger' : 'warn'}`} role="alert" style={{ alignItems: 'center' }}>
      <WarnIcon color={severe ? 'var(--danger)' : undefined} />
      <div className="grow stack" style={{ gap: 2 }}>
        {real.length > 0 && <strong>ალერგია: {real.map((a) => `${a.substance}${a.reaction_type ? ` — ${a.reaction_type}` : ''} (${SEVERITY_KA[a.severity]})`).join('; ')}</strong>}
        {intol.length > 0 && <span>აუტანლობა: {intol.map((a) => `${a.substance}${a.reaction_type ? ` — ${a.reaction_type}` : ''}`).join('; ')}</span>}
        {chronic && chronic.length > 0 && <span>ქრონიკული: {chronic.map((c) => `${c.condition_name}${c.icd10_code ? ` (${c.icd10_code})` : ''}`).join(' · ')}</span>}
      </div>
      {onAdd && <button className="btn sm" type="button" style={{ background: '#fff' }} onClick={onAdd}>+ ალერგია</button>}
    </div>
  );
}
