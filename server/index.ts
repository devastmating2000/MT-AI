import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { ServerEvent } from '../shared/types';
import { assertSafeToStart, Auth, bearer, cors, originAllowed, rateLimit, requireOperator, securityHeaders } from './auth';
import { createPool, PostgresStore } from './db';
import { LiveQuoteBroker } from './broker/liveQuotes';
import { Mt5BridgeBroker } from './broker/mt5Bridge';
import { PaperBroker } from './broker/paper';
import type { Broker } from './broker/types';
import { config } from './config';
import { Desk } from './desk';
import { specFor } from './symbols';

assertSafeToStart();
let store: PostgresStore | null = null;
if (config.databaseUrl) {
  store = new PostgresStore(createPool(config.databaseUrl));
  await store.migrate();
  if (!(await store.listOperators()).length) console.warn('Ainda não há operadores: ninguém consegue entrar. Crie um com "npm run user -- add <email>".');
}
const auth = new Auth(store);
if (config.mode === 'mt5' && config.bridgeToken.length < 16) {
  console.error('MTAI_BRIDGE_TOKEN tem de ter pelo menos 16 caracteres em modo mt5.');
  process.exit(1);
}

const broker: Broker = config.mode === 'mt5'
  ? new Mt5BridgeBroker(config.symbols)
  : config.mode === 'live'
  ? new LiveQuoteBroker(config.symbols.map(specFor), { balance: config.paperBalance, timeframeSec: config.timeframeSec })
  : new PaperBroker(config.symbols.map(specFor), {
    balance: config.paperBalance, candleMs: config.simCandleMs, seed: config.simSeed, timeframeSec: config.timeframeSec,
  });

const desk = new Desk(broker, { mode: config.mode, symbols: config.symbols, tradingEnabled: config.tradingEnabled });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(securityHeaders);
app.use(['/api', '/auth'], cors, express.json({ limit: '50kb' }));

// --- login --------------------------------------------------------------------------------
app.get('/auth/status', (_req, res) => { res.json({ required: auth.required }); });
// Ten attempts a minute per address, on top of the per-account lock after five wrong passwords.
app.post('/auth/login', rateLimit(10, 60_000), async (req, res) => {
  if (!req.is('application/json')) { res.status(415).json({ error: 'application/json obrigatório' }); return; }
  const session = await auth.login(req.body?.email, req.body?.password, req.ip ?? '', req.get('user-agent') ?? '').catch(() => null);
  if (!session) { res.status(401).json({ error: 'Email ou palavra-passe incorretos.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(session);
});
app.post('/auth/logout', async (req, res) => {
  await auth.logout(bearer(req)).catch(() => {});
  res.json({ ok: true });
});

app.use('/api', rateLimit(600, 60_000));
// State-changing calls must be JSON. A cross-site form cannot send that content type without a
// CORS preflight, which this server never grants.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    res.status(415).json({ error: 'application/json obrigatório' });
    return;
  }
  next();
});
// Everything under /api needs a signed-in, allow-listed operator when login is configured.
app.use('/api', requireOperator(auth));
app.get('/api/me', (_req, res) => { res.json(res.locals.operator); });

app.get('/api/state', (_req, res) => { res.json(desk.state()); });
app.get('/api/messages', (_req, res) => { res.json(desk.bus.history()); });
app.get('/api/candles', (req, res) => { res.json(desk.candles(String(req.query.symbol ?? '').toUpperCase())); });

app.post('/api/trading', (req, res) => {
  desk.setTrading(Boolean(req.body?.enabled));
  auth.audit(res.locals.operator.email, req.body?.enabled ? 'retomou a negociação' : 'pausou a negociação', req.ip ?? '');
  res.json({ tradingEnabled: desk.ctx.tradingEnabled });
});

app.post('/api/risk', (req, res) => {
  auth.audit(res.locals.operator.email, `alterou os limites de risco: ${JSON.stringify(req.body ?? {}).slice(0, 200)}`, req.ip ?? '');
  res.json(desk.setRisk(req.body ?? {}));
});

app.post('/api/positions/:id/close', async (req, res) => {
  try {
    await broker.closePosition(req.params.id, 'manual');
    auth.audit(res.locals.operator.email, `fechou a posição ${req.params.id}`, req.ip ?? '');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Endpoint polled by the MetaTrader 5 Expert Advisor.
app.post('/bridge/sync', rateLimit(300, 60_000), express.text({ type: () => true, limit: '8mb' }), (req, res) => {
  if (!(broker instanceof Mt5BridgeBroker)) {
    res.status(409).type('text/plain').send('ERROR|servidor em modo paper');
    return;
  }
  const given = Buffer.from(String(req.get('x-mtai-token') ?? ''));
  const expected = Buffer.from(config.bridgeToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.status(401).type('text/plain').send('ERROR|token inválido');
    return;
  }
  res.type('text/plain').send(broker.sync(typeof req.body === 'string' ? req.body : ''));
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/(api|auth|bridge|ws)).*/, (_req, res) => { res.sendFile(path.join(dist, 'index.html')); });
}

function sameOrAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // not a browser (curl, scripts); the token check still applies
  if (originAllowed(origin)) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

const server = createServer(app);
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 8192,
  // A page on another site must not be able to open the stream from a visitor's browser.
  verifyClient: (info: { origin?: string; req: IncomingMessage }) => sameOrAllowedOrigin(info.origin, info.req.headers.host),
});
const authed = new WeakSet<object>();
const tokens = new Map<object, string>();

function broadcast(event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === client.OPEN && authed.has(client)) client.send(data);
}

desk.onEvent = broadcast;
wss.on('connection', (socket) => {
  const admit = () => {
    authed.add(socket);
    socket.send(JSON.stringify({ type: 'state', state: desk.state() } satisfies ServerEvent));
  };
  if (!auth.required) { admit(); return; }
  // Browsers cannot set headers on a WebSocket, so the first message must carry the token.
  // Nothing is sent until it checks out, and silent sockets are dropped.
  const deadline = setTimeout(() => socket.close(4401, 'auth timeout'), 8000);
  socket.once('message', async (raw) => {
    clearTimeout(deadline);
    let token: string | undefined;
    try { token = JSON.parse(String(raw)).token; } catch { /* handled below */ }
    if (typeof token === 'string' && (await auth.verify(token).catch(() => null))) {
      tokens.set(socket, token);
      socket.once('close', () => tokens.delete(socket));
      admit();
    } else socket.close(4401, 'unauthorized');
  });
});
setInterval(() => { if (wss.clients.size) broadcast({ type: 'state', state: desk.state() }); }, 1000).unref();
// A stream opened with a session that has since expired or been signed out must not stay open.
setInterval(async () => {
  for (const [socket, token] of tokens) {
    if (!(await auth.verify(token).catch(() => null))) (socket as import('ws').WebSocket).close(4401, 'session ended');
  }
}, 30_000).unref();

await broker.start();
server.listen(config.port, config.host, () => {
  console.log(`MT-AI em http://${config.host}:${config.port}  modo=${config.mode}  negociação=${config.tradingEnabled ? 'ativa' : 'em pausa'}  IA=${config.llmEnabled ? config.llmModel : 'regras determinísticas'}  login=${auth.required ? 'obrigatório (Neon)' : 'desligado (só local)'}`);
  if (config.mode === 'mt5') console.log('À espera do Expert Advisor MTAI_Bridge em /bridge/sync ...');
});
