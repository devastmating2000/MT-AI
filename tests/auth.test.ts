import { beforeEach, describe, expect, it } from 'vitest';
import { Auth, checkPassword, hashPassword } from '../server/auth';
import { MemoryStore } from '../server/db';

const PASSWORD = 'uma-frase-bem-comprida-2026';
let store: MemoryStore;
let auth: Auth;
const login = (email: string, password: string) => auth.login(email, password, '1.2.3.4', 'vitest');

beforeEach(async () => {
  store = new MemoryStore();
  store.operators.push({ id: 1, email: 'dono@example.com', passwordHash: await hashPassword(PASSWORD), failedAttempts: 0, lockedUntil: null });
  auth = new Auth(store);
});

describe('passwords', () => {
  it('are stored salted and hashed, never in the clear', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toContain(PASSWORD);
    expect(a).not.toBe(b);
    expect(await checkPassword(PASSWORD, a)).toBe(true);
    expect(await checkPassword(PASSWORD + 'x', a)).toBe(false);
    expect(await checkPassword(PASSWORD, 'garbage')).toBe(false);
  });
});

describe('login and sessions', () => {
  it('signs in with the right password and accepts the session token', async () => {
    const session = await login(' Dono@Example.com ', PASSWORD);
    expect(session?.email).toBe('dono@example.com');
    expect(await auth.verify(session!.token)).toEqual({ email: 'dono@example.com' });
    // The database only ever sees a hash of the token.
    expect([...store.sessions.keys()][0]).not.toBe(session!.token);
  });

  it('rejects wrong passwords, unknown emails and malformed input the same way', async () => {
    expect(await login('dono@example.com', 'errada-errada-errada')).toBeNull();
    expect(await login('ninguem@example.com', PASSWORD)).toBeNull();
    expect(await auth.login({ $ne: null }, PASSWORD, '', '')).toBeNull();
    expect(await auth.login("' or 1=1 --", "' or 1=1 --", '', '')).toBeNull();
    expect(await login('dono@example.com', 'x'.repeat(10_000))).toBeNull();
  });

  it('rejects missing, forged and oversized tokens', async () => {
    expect(await auth.verify(undefined)).toBeNull();
    expect(await auth.verify('forged')).toBeNull();
    expect(await auth.verify('x'.repeat(5000))).toBeNull();
  });

  it('locks the account after five wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 5; i++) expect(await login('dono@example.com', `tentativa-errada-${i}`)).toBeNull();
    expect(store.operators[0].lockedUntil).toBeGreaterThan(Date.now());
    expect(await login('dono@example.com', PASSWORD)).toBeNull();
    store.operators[0].lockedUntil = Date.now() - 1; // lock expires
    expect(await login('dono@example.com', PASSWORD)).not.toBeNull();
  });

  it('ends the session on logout and on expiry', async () => {
    const a = await login('dono@example.com', PASSWORD);
    await auth.logout(a!.token);
    expect(await auth.verify(a!.token)).toBeNull();

    const b = await login('dono@example.com', PASSWORD);
    for (const s of store.sessions.values()) s.expiresAt = Date.now() - 1;
    expect(await new Auth(store).verify(b!.token)).toBeNull();
  });

  it('records sign-ins and failures in the audit log', async () => {
    await login('dono@example.com', 'errada-errada-errada');
    await login('dono@example.com', PASSWORD);
    expect(store.log.map((l) => l.action)).toEqual(['palavra-passe errada', 'entrou']);
  });

  it('lets everything through only when no database is configured (local use)', async () => {
    const open = new Auth(null);
    expect(open.required).toBe(false);
    expect(await open.verify(undefined)).toEqual({ email: 'local' });
  });
});
