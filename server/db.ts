import pg from 'pg';

export interface OperatorRow {
  id: number;
  email: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
}

/** Everything the login system needs to remember. Postgres in production, memory in tests. */
export interface AuthStore {
  findOperator(email: string): Promise<OperatorRow | null>;
  /** Count a wrong password; when `lockUntil` is given the account is locked and the count resets. */
  recordFailure(id: number, lockUntil: number | null): Promise<void>;
  resetFailures(id: number): Promise<void>;
  createSession(tokenHash: string, operatorId: number, expiresAt: number, ip: string, userAgent: string): Promise<void>;
  findSession(tokenHash: string): Promise<{ email: string; expiresAt: number } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  audit(email: string, action: string, ip: string): Promise<void>;
}

const SCHEMA = `
create table if not exists operators (
  id              bigint generated always as identity primary key,
  email           text not null unique check (email = lower(email)),
  password_hash   text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);
create table if not exists sessions (
  token_hash  text primary key,
  operator_id bigint not null references operators(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  ip          text not null default '',
  user_agent  text not null default ''
);
create index if not exists sessions_expires_at on sessions (expires_at);
create table if not exists audit_log (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  email  text not null,
  action text not null,
  ip     text not null default ''
);
`;

export function createPool(url: string): pg.Pool {
  const host = new URL(url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  // Neon requires TLS; verify the certificate rather than merely encrypting.
  return new pg.Pool({ connectionString: url, max: 5, ssl: local ? undefined : { rejectUnauthorized: true } });
}

/** Every statement is parameterised: no value from a request is ever spliced into SQL. */
export class PostgresStore implements AuthStore {
  constructor(private readonly pool: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
    await this.pool.query('delete from sessions where expires_at < now()');
  }

  async findOperator(email: string): Promise<OperatorRow | null> {
    const { rows } = await this.pool.query(
      'select id, email, password_hash, failed_attempts, locked_until from operators where email = $1', [email]);
    const r = rows[0];
    return r ? { id: Number(r.id), email: r.email, passwordHash: r.password_hash, failedAttempts: r.failed_attempts, lockedUntil: r.locked_until ? r.locked_until.getTime() : null } : null;
  }

  async recordFailure(id: number, lockUntil: number | null): Promise<void> {
    if (lockUntil) await this.pool.query('update operators set failed_attempts = 0, locked_until = $2 where id = $1', [id, new Date(lockUntil)]);
    else await this.pool.query('update operators set failed_attempts = failed_attempts + 1 where id = $1', [id]);
  }

  async resetFailures(id: number): Promise<void> {
    await this.pool.query('update operators set failed_attempts = 0, locked_until = null where id = $1', [id]);
  }

  async createSession(tokenHash: string, operatorId: number, expiresAt: number, ip: string, userAgent: string): Promise<void> {
    await this.pool.query('insert into sessions (token_hash, operator_id, expires_at, ip, user_agent) values ($1, $2, $3, $4, $5)',
      [tokenHash, operatorId, new Date(expiresAt), ip, userAgent.slice(0, 300)]);
  }

  async findSession(tokenHash: string): Promise<{ email: string; expiresAt: number } | null> {
    const { rows } = await this.pool.query(
      'select o.email, s.expires_at from sessions s join operators o on o.id = s.operator_id where s.token_hash = $1 and s.expires_at > now()', [tokenHash]);
    return rows[0] ? { email: rows[0].email, expiresAt: rows[0].expires_at.getTime() } : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('delete from sessions where token_hash = $1', [tokenHash]);
  }

  async audit(email: string, action: string, ip: string): Promise<void> {
    await this.pool.query('insert into audit_log (email, action, ip) values ($1, $2, $3)', [email, action.slice(0, 300), ip]);
  }

  // --- used by the account tool (server/users.ts) -----------------------------------------
  async upsertOperator(email: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      `insert into operators (email, password_hash) values ($1, $2)
       on conflict (email) do update set password_hash = excluded.password_hash, failed_attempts = 0, locked_until = null`, [email, passwordHash]);
    // A new password signs every existing device out.
    await this.pool.query('delete from sessions where operator_id = (select id from operators where email = $1)', [email]);
  }

  async removeOperator(email: string): Promise<boolean> {
    const r = await this.pool.query('delete from operators where email = $1', [email]);
    return (r.rowCount ?? 0) > 0;
  }

  async listOperators(): Promise<Array<{ email: string; createdAt: Date; sessions: number }>> {
    const { rows } = await this.pool.query(
      `select o.email, o.created_at, count(s.token_hash) filter (where s.expires_at > now()) as sessions
       from operators o left join sessions s on s.operator_id = o.id group by o.id order by o.email`);
    return rows.map((r) => ({ email: r.email, createdAt: r.created_at, sessions: Number(r.sessions) }));
  }
}

export class MemoryStore implements AuthStore {
  operators: OperatorRow[] = [];
  sessions = new Map<string, { operatorId: number; expiresAt: number }>();
  log: Array<{ email: string; action: string }> = [];
  async findOperator(email: string) { return this.operators.find((o) => o.email === email) ?? null; }
  async recordFailure(id: number, lockUntil: number | null) {
    const o = this.operators.find((x) => x.id === id)!;
    if (lockUntil) { o.failedAttempts = 0; o.lockedUntil = lockUntil; } else o.failedAttempts++;
  }
  async resetFailures(id: number) { const o = this.operators.find((x) => x.id === id)!; o.failedAttempts = 0; o.lockedUntil = null; }
  async createSession(tokenHash: string, operatorId: number, expiresAt: number) { this.sessions.set(tokenHash, { operatorId, expiresAt }); }
  async findSession(tokenHash: string) {
    const s = this.sessions.get(tokenHash);
    if (!s || s.expiresAt <= Date.now()) return null;
    return { email: this.operators.find((o) => o.id === s.operatorId)!.email, expiresAt: s.expiresAt };
  }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async audit(email: string, action: string) { this.log.push({ email, action }); }
}
