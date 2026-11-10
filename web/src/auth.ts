import { useEffect, useState } from 'react';

/** Where the agent server lives. Empty means "same origin as this page". */
export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');

const KEY = 'mtai.session';

interface Stored {
  token: string;
  email: string;
  expiresAt: number;
}

export type Session =
  | { status: 'checking' }
  | { status: 'unreachable' }
  | { status: 'open' } // server runs without login (local use)
  | { status: 'signedOut' }
  | { status: 'signedIn'; email: string };

let current: Session = { status: 'checking' };
const listeners = new Set<(s: Session) => void>();

function set(next: Session): void {
  current = next;
  for (const fn of listeners) fn(next);
}

function read(): Stored | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    return s && typeof s.token === 'string' && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function accessToken(): string | null {
  return read()?.token ?? null;
}

function forget(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  if (current.status === 'signedIn') set({ status: 'signedOut' });
}

/** fetch() against the agent server with the operator's token attached. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = accessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401 && path.startsWith('/api')) forget(); // session expired or revoked
  return res;
}

export function socketUrl(): string {
  return `${(API_BASE || location.origin).replace(/^http/, 'ws')}/ws`;
}

export async function signIn(email: string, password: string): Promise<'ok' | 'wrong' | 'throttled' | 'unreachable'> {
  let res: Response;
  try {
    res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  } catch {
    return 'unreachable';
  }
  if (res.status === 429) return 'throttled';
  if (!res.ok) return 'wrong';
  const session = (await res.json()) as Stored;
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch { /* storage unavailable */ }
  set({ status: 'signedIn', email: session.email });
  return 'ok';
}

export async function signOut(): Promise<void> {
  await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  forget();
}

/** Called when the server closes the live stream for lack of a valid session. */
export const sessionRejected = forget;

async function check(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/auth/status`);
    if (!res.ok) throw new Error(String(res.status));
    const { required } = (await res.json()) as { required: boolean };
    if (!required) { set({ status: 'open' }); return; }
    const stored = read();
    if (!stored) { set({ status: 'signedOut' }); return; }
    const me = await api('/api/me');
    set(me.ok ? { status: 'signedIn', email: stored.email } : { status: 'signedOut' });
  } catch {
    set({ status: 'unreachable' });
    window.setTimeout(check, 3000);
  }
}

let started = false;
export function useSession(): Session {
  const [session, setSession] = useState(current);
  useEffect(() => {
    listeners.add(setSession);
    setSession(current);
    if (!started) { started = true; void check(); }
    return () => { listeners.delete(setSession); };
  }, []);
  return session;
}
