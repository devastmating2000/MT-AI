import type { Candle, Direction, StrategyId, StrategyStats, SymbolSpec } from '../../shared/types';
import { buildSeries, STRATEGIES, WARMUP, type Series, type Strategy } from '../strategies';

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  direction: Direction;
  /** Result in multiples of the initial risk, after spread. */
  r: number;
  plannedRR: number;
}

export interface BacktestResult {
  strategy: StrategyId;
  symbol: string;
  trades: BacktestTrade[];
}

const MAX_BARS_IN_TRADE = 96;

/**
 * Bar-by-bar simulation of one strategy, one position at a time.
 * Signals on bar i are filled at the open of bar i+1. When a bar touches both the stop and the
 * target, the stop is assumed to have been hit first (the pessimistic reading of OHLC data).
 */
export function backtestStrategy(strategy: Strategy, s: Series): BacktestResult {
  const { candles, spec } = s;
  const spread = spec.spreadPips * spec.pip;
  const trades: BacktestTrade[] = [];
  let open: { dir: Direction; entry: number; sl: number; tp: number; risk: number; index: number; rr: number } | null = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const c = candles[i];
    if (open) {
      const long = open.dir === 'long';
      const hitSl = long ? c.low <= open.sl : c.high >= open.sl;
      const hitTp = long ? c.high >= open.tp : c.low <= open.tp;
      let exit: number | null = null;
      if (hitSl) exit = open.sl;
      else if (hitTp) exit = open.tp;
      else if (i - open.index >= MAX_BARS_IN_TRADE) exit = c.close;
      if (exit !== null) {
        const gross = (long ? exit - open.entry : open.entry - exit) / open.risk;
        trades.push({ entryIndex: open.index, exitIndex: i, direction: open.dir, r: gross - spread / open.risk, plannedRR: open.rr });
        open = null;
      }
    }
    if (!open && i + 1 < candles.length) {
      const setup = strategy.evaluate(s, i);
      if (!setup) continue;
      const entry = candles[i + 1].open;
      const long = setup.direction === 'long';
      const risk = long ? entry - setup.stopLoss : setup.stopLoss - entry;
      const reward = long ? setup.takeProfit - entry : entry - setup.takeProfit;
      // A gap through the levels invalidates the setup.
      if (risk <= spread * 2 || reward <= 0) continue;
      open = { dir: setup.direction, entry, sl: setup.stopLoss, tp: setup.takeProfit, risk, index: i + 1, rr: reward / risk };
    }
  }
  return { strategy: strategy.id, symbol: spec.symbol, trades };
}

export function summarize(result: BacktestResult, now: number): StrategyStats {
  const rs = result.trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const n = rs.length;
  return {
    strategy: result.strategy,
    symbol: result.symbol,
    trades: n,
    wins: wins.length,
    winRate: n ? wins.length / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    expectancyR: n ? (grossWin - grossLoss) / n : 0,
    maxDrawdownR: maxDd,
    avgRewardRisk: n ? result.trades.reduce((a, t) => a + t.plannedRR, 0) / n : 0,
    weight: 0,
    benched: true,
    liveTrades: 0,
    liveWins: 0,
    updatedAt: now,
  };
}

export const MIN_TRADES = 10;

/**
 * Turn raw statistics into vote weights. Win rate drives the ranking, but a strategy only gets a
 * vote if it also has positive expectancy: a high win rate with small wins and large losses
 * still loses money.
 */
export function assignWeights(stats: StrategyStats[]): StrategyStats[] {
  const raw = stats.map((s) => {
    const trades = s.trades + s.liveTrades * 3;
    const wins = s.wins + s.liveWins * 3;
    const winRate = trades ? wins / trades : 0;
    if (s.trades < MIN_TRADES) return { s, raw: 0, reason: 'amostra pequena' };
    if (s.expectancyR <= 0 || s.profitFactor < 1.05) return { s, raw: 0, reason: 'expectativa negativa' };
    const quality = Math.min(1, Math.max(0.5, s.profitFactor / 2));
    const sample = Math.min(1, s.trades / 30);
    return { s, raw: winRate * quality * sample, reason: undefined };
  });
  const max = Math.max(0, ...raw.map((r) => r.raw));
  return raw.map(({ s, raw: w, reason }) => ({
    ...s,
    weight: max > 0 ? w / max : 0,
    benched: w === 0,
    benchReason: reason,
  }));
}

export function backtestAll(candles: Candle[], spec: SymbolSpec, now: number): StrategyStats[] {
  if (candles.length <= WARMUP + 50) return [];
  const s = buildSeries(candles, spec);
  return assignWeights(STRATEGIES.map((st) => summarize(backtestStrategy(st, s), now)));
}
