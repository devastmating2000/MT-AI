import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import type { AuthStore } from './db';

export interface Operator {
  email: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const SESSION_MS = 12 * 3_600_000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
export const MIN_PASSWORD = 12;

// scrypt cost: 32 MB of memory per guess, which makes offline cracking of a stolen table slow.
const N = 32_768;
const R = 8;
const P = 1;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Login, session checks and logout against a store (Neon/Postgres in production). */
export class Auth {
  private readonly cache = new Map<string, { operator: Operator; until: number }>();
  // Checked for accounts that do not exist, so an unknown email takes as long as a wrong password.
  private readonly decoy = hashPassword(randomBytes(18).toString('base64'));

  constructor(private readonly store: AuthStore | null) {}

  /** Login is enforced whenever a database is configured. */
  get required(): boolean { return this.store !== null; }

  /**
   * Returns a fresh session token, or null. The caller must answer every null the same way:
   * unknown email, wrong password and locked account are indistinguishable from outside.
   */
  async login(emailRaw: unknown, password: unknown, ip: string, userAgent: string): Promise<{ token: string; email: string; expiresAt: number } | null> {
    if (!this.store || typeof emailRaw !== 'string' || typeof password !== 'string') return null;
    const email = emailRaw.trim().toLowerCase();
    if (!email || email.length > 254 || !password || password.length > 256) return null;

    const op = await this.store.findOperator(email);
    const locked = Boolean(op?.lockedUntil && op.lockedUntil > Date.now());
    const ok = await checkPassword(password, op?.passwordHash ?? (await this.decoy));
    if (!op || locked || !ok) {
      if (op && !locked) {
        const lock = op.failedAttempts + 1 >= MAX_FAILURES;
        await this.store.recordFailure(op.id, lock ? Date.now() + LOCK_MS : null);
        await this.store.audit(email, lock ? 'conta bloqueada 15 min após tentativas falhadas' : 'palavra-passe errada', ip);
      }
      return null;
    }
    await this.store.resetFailures(op.id);
    // 256 random bits. Only its hash is stored, so a leaked database cannot be replayed as sessions.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_MS;
    await this.store.createSession(sha256(token), op.id, expiresAt, ip, userAgent);
    await this.store.audit(email, 'entrou', ip);
    return { token, email, expiresAt };
  }

  async verify(token: string | undefined): Promise<Operator | null> {
    if (!this.store) return { email: 'local' };
    if (!token || token.length > 128) return null;
    const hash = sha256(token);
    const hit = this.cache.get(hash);
    if (hit && hit.until > Date.now()) return hit.operator;
    const session = await this.store.findSession(hash);
    if (!session) return null;
    const operator = { email: session.email };
    if (this.cache.size > 500) this.cache.clear();
    // Short cache so the database is not asked on every request; a removed account loses access within 30 s.
    this.cache.set(hash, { operator, until: Math.min(session.expiresAt, Date.now() + 30_000) });
    return operator;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!this.store || !token) return;
    const hash = sha256(token);
    this.cache.delete(hash);
    await this.store.deleteSession(hash);
  }

  audit(email: string, action: string, ip: string): void {
    console.log(`[audit] ${email} ${action}`);
    this.store?.audit(email, action, ip).catch((err) => console.warn('[audit] não gravado:', err.message));
  }
}

/** Refuse to start reachable from other machines with no login in front of the trading controls. */
export function assertSafeToStart(): void {
  if (!config.databaseUrl && !LOOPBACK.has(config.host)) {
    console.error(`HOST=${config.host} expõe o servidor a outras máquinas, mas não há login configurado.\n`
      + 'Defina DATABASE_URL (Neon) e crie um operador com "npm run user -- add <email>", ou volte a HOST=127.0.0.1.');
    process.exit(1);
  }
}

export function bearer(req: Request): string | undefined {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : undefined;
}

export function requireOperator(auth: Auth) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const operator = await auth.verify(bearer(req)).catch(() => null);
    if (!operator) {
      res.status(401).json({ error: 'Sessão inválida ou expirada' });
      return;
    }
    res.locals.operator = operator;
    next();
  };
}

export function originAllowed(origin: string | undefined): boolean {
  return Boolean(origin) && config.allowedOrigins.includes(origin!);
}

/** Cross-origin access only for the dashboard origins named in MTAI_ALLOWED_ORIGINS. */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(originAllowed(origin) ? 204 : 403).end();
    return;
  }
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
    + "connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  if (config.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** Fixed-window limiter per client address. */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      if (hits.size > 5000) hits.clear();
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    if (++entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      res.status(429).json({ error: 'Demasiados pedidos. Tente de novo dentro de um minuto.' });
      return;
    }
    next();
  };
}
