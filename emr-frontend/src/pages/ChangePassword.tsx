import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SessionResponse } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { homeFor } from '../components/Shell';
import { ErrorBox, Field } from '../components/ui';

export default function ChangePassword() {
  const { user, applySession } = useAuth();
  const nav = useNavigate();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [rep, setRep] = useState('');
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const weak = next.length > 0 && (next.length < 10 || !/[A-Za-z]/.test(next) || !/\d/.test(next));
  const mismatch = rep.length > 0 && rep !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (weak || mismatch) return;
    setErr(null); setBusy(true);
    try {
      const s = await api<SessionResponse>('/auth/change-password', { body: { currentPassword: cur, newPassword: next } });
      applySession(s); nav(homeFor(s.user), { replace: true });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 20 }}>
      <form onSubmit={submit} className="card" style={{ width: 'min(420px, 100%)', padding: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 style={{ fontSize: 20 }}>პაროლის შეცვლა</h1>
        {user?.mustChangePassword && <div className="alert info">დროებითი პაროლით შეხვედით. გასაგრძელებლად დააყენეთ საკუთარი პაროლი.</div>}
        <Field label="მიმდინარე პაროლი" htmlFor="c"><input id="c" className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
        <Field label="ახალი პაროლი" htmlFor="n" hint="მინიმუმ 10 სიმბოლო, ასო და ციფრი" error={weak ? 'პაროლი მოთხოვნებს არ აკმაყოფილებს' : undefined}>
          <input id="n" className={`input${weak ? ' invalid' : ''}`} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label="გაიმეორეთ" htmlFor="r" error={mismatch ? 'პაროლები არ ემთხვევა' : undefined}>
          <input id="r" className={`input${mismatch ? ' invalid' : ''}`} type="password" autoComplete="new-password" value={rep} onChange={(e) => setRep(e.target.value)} required />
        </Field>
        <ErrorBox error={err} />
        <button className="btn primary lg" type="submit" disabled={busy || weak || mismatch}>პაროლის შენახვა</button>
      </form>
    </div>
  );
}
