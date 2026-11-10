// Usage: npm run simulate -- [SYMBOLS] [days] [seed]
// Example: npm run simulate -- XAUUSD 90
// Runs the whole desk (all agents, risk limits, news blackout, event specialist) on the
// simulator as fast as the machine allows and prints a summary. Prices are synthetic.
import { STRATEGY_LABELS, type ClosedTrade } from '../shared/types';
import { PaperBroker } from './broker/paper';
import { config } from './config';
import { Desk } from './desk';
import { specFor } from './symbols';

const symbols = (process.argv[2] ?? 'XAUUSD').toUpperCase().split(',');
const days = Number(process.argv[3] ?? 60);
const seed = Number(process.argv[4] ?? config.simSeed);
const balance = config.paperBalance;

const broker = new PaperBroker(symbols.map(specFor), { balance, candleMs: 1000, seed, timeframeSec: config.timeframeSec });
const desk = new Desk(broker, { mode: 'paper', symbols, tradingEnabled: true });
const trades: ClosedTrade[] = [];
broker.on('closed', (t) => trades.push(t));
let halts = 0;
let blackouts = 0;
desk.onEvent = (e) => {
  if (e.type !== 'message') return;
  if (e.message.topic === 'risk.halt') halts++;
  if (e.message.topic === 'news.brief' && e.message.kind === 'warn') blackouts++;
};

broker.seed(Date.UTC(2026, 10, 9) / 1000);
let peak = balance;
let maxDd = 0;
for (let i = 0; i < days * 96; i++) {
  broker.stepCandle();
  await new Promise((r) => setImmediate(r));
  const eq = broker.account().equity;
  peak = Math.max(peak, eq);
  maxDd = Math.max(maxDd, (peak - eq) / peak);
}

const n = (v: number, d = 2) => v.toFixed(d);
const wins = trades.filter((t) => t.pnl > 0);
const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
const end = broker.account().equity;

console.log(`\nSimulação ${symbols.join(', ')}: ${days} dias de velas M15, semente ${seed} (preços sintéticos)\n`);
console.log(`Capital          ${n(balance)} -> ${n(end)} USD (${end >= balance ? '+' : ''}${n(((end - balance) / balance) * 100)}%)`);
console.log(`Operações        ${trades.length} fechadas, ${broker.positions().length} aberta(s)`);
console.log(`Taxa de acerto   ${trades.length ? n((wins.length / trades.length) * 100, 1) : '0'}%`);
console.log(`Fator de lucro   ${grossLoss > 0 ? n(grossWin / grossLoss) : 'n/d'}`);
console.log(`Média por op.    ${trades.length ? n(trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length) : '0'} R`);
console.log(`Queda máxima     ${n(maxDd * 100)}%`);
console.log(`Bloqueios        ${blackouts} por notícias, ${halts} dia(s) parado(s) pelo limite de perdas`);

console.log('\nPor estratégia          ops  acerto   soma R');
const byStrategy = new Map<string, ClosedTrade[]>();
for (const t of trades) for (const s of t.strategies) byStrategy.set(s, [...(byStrategy.get(s) ?? []), t]);
for (const [s, list] of [...byStrategy].sort((a, b) => b[1].length - a[1].length)) {
  const w = list.filter((t) => t.pnl > 0).length;
  const r = list.reduce((a, t) => a + t.rMultiple, 0);
  console.log(`${STRATEGY_LABELS[s as keyof typeof STRATEGY_LABELS].padEnd(22)} ${String(list.length).padStart(4)}  ${n((w / list.length) * 100, 0).padStart(5)}%  ${(r >= 0 ? '+' : '') + n(r, 1)}`);
}
process.exit(0);
