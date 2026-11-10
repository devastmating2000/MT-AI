// Usage: npm run live -- [SYMBOLS] [minutes] [timeframeSec]
// Example: npm run live -- XAUUSD 30 60
// Add --force to let benched strategies vote anyway (to exercise execution; expect losses).
// Runs the full desk on REAL quotes with SIMULATED fills for a fixed time, printing every
// message the agents exchange, then closes whatever is open at the market and prints a summary.
import { STRATEGY_LABELS, type ClosedTrade } from '../shared/types';
import { LiveQuoteBroker } from './broker/liveQuotes';
import { config } from './config';
import { Desk } from './desk';
import { specFor } from './symbols';

const symbols = (process.argv[2] ?? 'XAUUSD').toUpperCase().split(',');
const minutes = Number(process.argv[3] ?? 30);
const timeframeSec = Number(process.argv[4] ?? 60);
const ignoreBench = process.argv.includes('--force');
const balance = config.paperBalance;
const clock = () => new Date().toISOString().slice(11, 19);
const names: Record<string, string> = {};

const broker = new LiveQuoteBroker(symbols.map(specFor), { balance, timeframeSec });
const desk = new Desk(broker, { mode: 'live', symbols, tradingEnabled: true, ignoreBench });
for (const a of desk.bus.roster()) names[a.id] = a.name;
const trades: ClosedTrade[] = [];
broker.on('closed', (t) => trades.push(t));
let candles = 0;
let hi = -Infinity;
let lo = Infinity;
let first = 0;
let lastMid = 0;
broker.on('candle', () => { candles++; });
broker.on('tick', (t) => {
  const mid = (t.bid + t.ask) / 2;
  if (t.symbol !== symbols[0]) return;
  first ||= mid;
  lastMid = mid;
  hi = Math.max(hi, mid);
  lo = Math.min(lo, mid);
});
desk.onEvent = (e) => {
  if (e.type === 'message') console.log(`${clock()} ${names[e.message.from]}${e.message.to === 'all' ? '' : ` para ${names[e.message.to]}`}: ${e.message.text}`);
};

console.log(`${clock()} UTC. Teste ao vivo: ${symbols.join(', ')}, ${minutes} min, velas de ${timeframeSec}s, capital ${balance} USD, sem modelo de linguagem: ${!config.llmEnabled}${ignoreBench ? ', MODO FORÇADO: estratégias no banco também votam' : ''}`);
await broker.start();
const spec = desk.ctx.specs.get(symbols[0])!;
console.log(`${clock()} Spread real medido em ${symbols[0]}: ${(spec.spreadPips * spec.pip).toFixed(3)}`);

const status = setInterval(() => {
  const a = broker.account();
  console.log(`${clock()} -- ${symbols[0]} ${lastMid.toFixed(spec.digits)}, capital ${a.equity.toFixed(2)}, ${broker.positions().length} posição(ões) aberta(s), ${trades.length} fechada(s)`);
}, 5 * 60_000);

await new Promise((r) => setTimeout(r, minutes * 60_000));
clearInterval(status);
for (const p of broker.positions()) await broker.closePosition(p.id, 'manual').catch(() => {});
broker.stop();

const n = (v: number, d = 2) => v.toFixed(d);
const end = broker.account().equity;
const wins = trades.filter((t) => t.pnl > 0).length;
console.log(`\n===== Resumo (${clock()} UTC) =====`);
console.log(`Preço ${symbols[0]}    início ${n(first)}, fim ${n(lastMid)}, mínimo ${n(lo)}, máximo ${n(hi)}`);
console.log(`Velas fechadas   ${candles}; cotações pedidas ${broker.polls}, falhadas ${broker.errors}`);
console.log(`Capital          ${n(balance)} -> ${n(end)} USD (${end >= balance ? '+' : ''}${n(end - balance)})`);
console.log(`Operações        ${trades.length}, com lucro ${wins}`);
for (const t of trades) {
  console.log(`  ${new Date(t.openTime).toISOString().slice(11, 19)} ${t.direction === 'long' ? 'compra' : 'venda'} ${t.lots} @ ${t.entryPrice} -> ${t.exitPrice} (${t.reason}) ${t.pnl >= 0 ? '+' : ''}${n(t.pnl)} USD, ${n(t.rMultiple)}R, ${t.strategies.map((s) => STRATEGY_LABELS[s]).join(' + ')}`);
}
console.log('Estratégias      ' + desk.state().stats.map((s) => `${STRATEGY_LABELS[s.strategy]}: ${s.benched ? `banco (${s.benchReason})` : `peso ${n(s.weight)}`} ${n(s.winRate * 100, 0)}%/${s.trades}`).join('; '));
process.exit(0);
