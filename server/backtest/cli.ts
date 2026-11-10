// Usage: npm run backtest -- [bars] [seed]
// Backtests every strategy on synthetic data. For real history, run the desk in mt5 mode:
// the strategist agent backtests on the candles your broker sends.
import { config } from '../config';
import { SimMarket } from '../broker/simMarket';
import { specFor } from '../symbols';
import { backtestAll } from './engine';

const bars = Number(process.argv[2] ?? 6000);
const seed = Number(process.argv[3] ?? config.simSeed);
const end = Math.floor(Date.UTC(2026, 0, 5) / 1000) + bars * config.timeframeSec;

console.log(`Dados sintéticos, ${bars} velas M15 por símbolo, semente ${seed}\n`);
console.log('símbolo  estratégia          ops  acerto    PF   exp(R)  DD(R)  peso');
config.symbols.forEach((symbol, i) => {
  const spec = specFor(symbol);
  const candles = new SimMarket(spec, seed + i * 7919).history(bars, end, config.timeframeSec);
  for (const s of backtestAll(candles, spec, Date.now())) {
    console.log(
      `${symbol.padEnd(8)} ${s.strategy.padEnd(18)} ${String(s.trades).padStart(4)}  ${(s.winRate * 100).toFixed(1).padStart(5)}%  ${s.profitFactor.toFixed(2).padStart(5)}  ${s.expectancyR.toFixed(3).padStart(6)}  ${s.maxDrawdownR.toFixed(1).padStart(5)}  ${s.benched ? 'banco' : s.weight.toFixed(2)}`,
    );
  }
});
