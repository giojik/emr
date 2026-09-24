import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setSessionListener, type SessionResponse, type SessionUser } from '../api/client';

interface AuthState {
  user: SessionUser | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  applySession: (s: SessionResponse) => void;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const applySession = useCallback((s: SessionResponse | null) => {
    window.clearTimeout(timer.current);
    if (!s) { setAccessToken(null); setUser(null); return; }
    setAccessToken(s.accessToken); setUser(s.user);
    // access token-ის განახლება ვადის გასვლამდე 1 წუთით ადრე
    timer.current = window.setTimeout(() => { void refreshSession(); }, Math.max(30, s.expiresIn - 60) * 1000);
  }, []);

  useEffect(() => {
    setSessionListener(applySession);
    refreshSession().finally(() => setReady(true));   // გვერდის გადატვირთვისას სესიის აღდგენა cookie-თი
    return () => window.clearTimeout(timer.current);
  }, [applySession]);

  const login = useCallback(async (username: string, password: string) => {
    const s = await api<SessionResponse>('/auth/login', { body: { username, password } });
    applySession(s); return s.user;
  }, [applySession]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } finally { applySession(null); }
  }, [applySession]);

  return <Ctx.Provider value={{ user, ready, login, logout, applySession }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
