import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import PatientSearch from '../components/PatientSearch';

export default function Patients() {
  const nav = useNavigate(); const { user } = useAuth();
  const canCreate = user?.role === 'admin' || user?.role === 'receptionist';
  return (
    <>
      <header className="topbar"><h1 className="grow">პაციენტები</h1>{canCreate && <Link className="btn primary" to="/patients/new">+ ახალი პაციენტი</Link>}</header>
      <div className="content">
        <div className="card card-pad stack" style={{ maxWidth: 720 }}>
          <span className="label">ძებნა</span>
          <PatientSearch autoFocus onSelect={(p) => nav(`/patients/${p.id}`)} />
          <span className="hint">მინიმუმ 2 სიმბოლო. მსგავსი გვარებიც მოიძებნება (მაგ. „ბერიზე“ → „ბერიძე“).</span>
        </div>
      </div>
    </>
  );
}
