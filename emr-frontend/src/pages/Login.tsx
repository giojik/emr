import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { homeFor } from '../components/Shell';
import { ErrorBox, Field } from '../components/ui';

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const u = await login(username, password);
      nav(u.mustChangePassword ? '/change-password' : loc.state?.from ?? homeFor(u.role), { replace: true });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 20 }}>
      <form onSubmit={submit} className="card" style={{ width: 'min(400px, 100%)', padding: 32, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="row"><div className="brand-mark">EMR</div><div className="stack" style={{ gap: 0 }}><strong>ინოვა მედიკალი</strong><span className="small muted">სამედიცინო ინფორმაციული სისტემა</span></div></div>
        <h1 style={{ fontSize: 20 }}>შესვლა</h1>
        <Field label="მომხმარებელი" htmlFor="u" hint="ელ-ფოსტა ან დომენის სახელი (Windows)">
          <input id="u" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </Field>
        <Field label="პაროლი" htmlFor="p">
          <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorBox error={err} />
        <button className="btn primary lg" type="submit" disabled={busy}>{busy ? 'შესვლა…' : 'შესვლა'}</button>
      </form>
    </div>
  );
}
