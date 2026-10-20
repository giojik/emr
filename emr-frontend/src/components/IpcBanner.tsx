import { Link } from 'react-router-dom';
import { can } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { tsDate } from '../lib/format';
import { IPC_ANY, ISO_KA, ONSET_KA, usePatientIpc } from '../pages/ipc/types';

/**
 * ინფექციის კონტროლის ბანერი (0067) — პაციენტის თავში: აქტიური MDRO ფლაგები, მიმდინარე ჰოსპიტალიზაციის იზოლაციები,
 * შეთავაზებული იზოლაცია (ფლაგი არის, შესაბამისი იზოლაცია — არა). მოდული გამორთულია / წვდომა არ არის → მხოლოდ იზოლაცია ან არაფერი.
 */
export default function IpcBanner({ patientId, compact, hideIsolations }: { patientId: string | null | undefined; compact?: boolean; hideIsolations?: boolean }) {
  const { user } = useAuth();
  const q = usePatientIpc(patientId);
  const x = q.data;
  if (!x) return null;
  const flags = x.flags; const iso = hideIsolations ? [] : x.isolations;
  if (!flags.length && !iso.length) return null;
  const ipc = can(user, ...IPC_ANY);
  return (
    <div className={`alert ${flags.some((f) => f.status === 'active') ? 'danger' : 'warn'}`} role="status" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <strong>ინფექციის კონტროლი:</strong>
      {flags.map((f) => (
        <span key={f.id} className={`chip ${f.status === 'active' ? 'danger' : 'warn'}`} style={{ background: '#fff' }}
          title={`${f.name}${f.onset ? ` · ${ONSET_KA[f.onset]}` : ''} · ${tsDate(f.specimen_at ?? f.detected_at)}${f.status === 'suggested' ? ' · დასადასტურებელი' : ''}`}>
          {ipc ? <Link to={`/ipc/flags/${f.id}`}>MDRO {f.mdro_code.toUpperCase()}</Link> : <>MDRO {f.mdro_code.toUpperCase()}</>}
          {f.status === 'suggested' && ' ?'}
        </span>))}
      {iso.map((i) => <span key={i.id} className="chip" style={{ background: i.color, color: '#fff', borderColor: i.color }} title={`იზოლაცია: ${i.name}`}>{i.short_name}</span>)}
      {!compact && x.suggestions.length > 0 && (
        <span className="small">· შესაბამისი იზოლაცია არ არის: {x.suggestions.map((s) => `${ISO_KA[s.isolation_type]} (${s.mdro_code.toUpperCase()})`).join(', ')}
          {x.stay && <> — <Link to={`/inpatient/stay/${x.stay.encounter_id}#isolation`}>იზოლაციის დაყენება</Link></>}</span>)}
    </div>
  );
}
