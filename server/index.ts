import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { ServerEvent } from '../shared/types';
import { LiveQuoteBroker } from './broker/liveQuotes';
import { Mt5BridgeBroker } from './broker/mt5Bridge';
import { PaperBroker } from './broker/paper';
import type { Broker } from './broker/types';
import { config } from './config';
import { Desk } from './desk';
import { specFor } from './symbols';

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
app.use('/api', express.json({ limit: '50kb' }));
// State-changing calls must be JSON. A cross-site form cannot send that content type without a
// CORS preflight, which this server never grants.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    res.status(415).json({ error: 'application/json obrigatório' });
    return;
  }
  next();
});

app.get('/api/state', (_req, res) => { res.json(desk.state()); });
app.get('/api/messages', (_req, res) => { res.json(desk.bus.history()); });
app.get('/api/candles', (req, res) => { res.json(desk.candles(String(req.query.symbol ?? '').toUpperCase())); });

app.post('/api/trading', (req, res) => {
  desk.setTrading(Boolean(req.body?.enabled));
  res.json({ tradingEnabled: desk.ctx.tradingEnabled });
});

app.post('/api/risk', (req, res) => { res.json(desk.setRisk(req.body ?? {})); });

app.post('/api/positions/:id/close', async (req, res) => {
  try {
    await broker.closePosition(req.params.id, 'manual');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Endpoint polled by the MetaTrader 5 Expert Advisor.
app.post('/bridge/sync', express.text({ type: () => true, limit: '8mb' }), (req, res) => {
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
  app.get(/^(?!\/(api|bridge|ws)).*/, (_req, res) => { res.sendFile(path.join(dist, 'index.html')); });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
}

desk.onEvent = broadcast;
wss.on('connection', (socket) => socket.send(JSON.stringify({ type: 'state', state: desk.state() } satisfies ServerEvent)));
setInterval(() => { if (wss.clients.size) broadcast({ type: 'state', state: desk.state() }); }, 1000).unref();

await broker.start();
server.listen(config.port, config.host, () => {
  console.log(`MT-AI em http://${config.host}:${config.port}  modo=${config.mode}  negociação=${config.tradingEnabled ? 'ativa' : 'em pausa'}  IA=${config.llmEnabled ? config.llmModel : 'regras determinísticas'}`);
  if (config.mode === 'mt5') console.log('À espera do Expert Advisor MTAI_Bridge em /bridge/sync ...');
});
