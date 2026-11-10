import { describe, expect, it } from 'vitest';
import type { Candle, StrategyStats } from '../shared/types';
import { assignWeights, backtestStrategy, summarize } from '../server/backtest/engine';
import { SimMarket } from '../server/broker/simMarket';
import { atr, donchian, ema, rsi, sma } from '../server/strategies/indicators';
import { buildSeries, STRATEGIES, WARMUP, type Strategy } from '../server/strategies';
import { specFor, valuePerPrice } from '../server/symbols';

const bar = (time: number, o: number, h: number, l: number, c: number): Candle => ({ time, open: o, high: h, low: l, close: c, volume: 1 });

describe('indicators', () => {
  it('sma and ema warm up and match hand calculations', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });

  it('rsi is 100 on a pure rise, 0 on a pure fall, 50 when flat', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up).at(-1)).toBe(100);
    expect(rsi(up.slice().reverse()).at(-1)).toBeCloseTo(0);
    expect(rsi(new Array(30).fill(5)).at(-1)).toBe(50);
  });

  it('atr of constant-range bars equals that range', () => {
    const candles = Array.from({ length: 40 }, (_, i) => bar(i * 900, 10, 11, 9, 10));
    expect(atr(candles).at(-1)).toBeCloseTo(2);
  });

  it('donchian excludes the current bar', () => {
    const candles = Array.from({ length: 25 }, (_, i) => bar(i * 900, 10, 10 + i, 10 - i, 10));
    const d = donchian(candles, 20);
    expect(d.high[24]).toBe(10 + 23);
    expect(d.low[24]).toBe(10 - 23);
  });
});

describe('backtest engine', () => {
  const spec = { ...specFor('EURUSD'), spreadPips: 0 };
  const flat = (n: number) => Array.from({ length: n }, (_, i) => bar(i * 900, 1, 1.0005, 0.9995, 1));

  function runWith(after: Candle[]) {
    const candles = [...flat(WARMUP + 1), ...after];
    const once: Strategy = {
      id: 'trend_pullback',
      evaluate: (_s, i) => (i === WARMUP ? { direction: 'long', confidence: 1, stopLoss: 0.99, takeProfit: 1.02, rationale: '' } : null),
    };
    return backtestStrategy(once, buildSeries(candles, spec)).trades;
  }

  it('fills on the next open and takes profit at the target', () => {
    const t = WARMUP * 900;
    const trades = runWith([bar(t + 900, 1, 1.001, 0.999, 1), bar(t + 1800, 1, 1.03, 0.999, 1.02)]);
    expect(trades).toHaveLength(1);
    expect(trades[0].r).toBeCloseTo(2);
  });

  it('assumes the stop was hit first when one bar touches stop and target', () => {
    const t = WARMUP * 900;
    const trades = runWith([bar(t + 900, 1, 1.03, 0.98, 1)]);
    expect(trades[0].r).toBeCloseTo(-1);
  });

  it('only uses data up to the evaluated bar (no look-ahead)', () => {
    const market = new SimMarket(specFor('EURUSD'), 7);
    const candles = market.history(600, 600 * 900, 900);
    const full = buildSeries(candles, specFor('EURUSD'));
    const cut = buildSeries(candles.slice(0, 500), specFor('EURUSD'));
    for (const s of STRATEGIES) {
      for (let i = WARMUP; i < 500; i++) expect(s.evaluate(cut, i)).toEqual(s.evaluate(full, i));
    }
  });
});

describe('strategy weights', () => {
  const stat = (over: Partial<StrategyStats>): StrategyStats => ({
    strategy: 'trend_pullback', symbol: 'EURUSD', trades: 40, wins: 22, winRate: 0.55, profitFactor: 1.5, expectancyR: 0.2,
    maxDrawdownR: 5, avgRewardRisk: 1.5, weight: 0, benched: true, liveTrades: 0, liveWins: 0, updatedAt: 0, ...over,
  });

  it('benches a high win rate that still loses money', () => {
    const [good, trap] = assignWeights([
      stat({}),
      stat({ strategy: 'mean_reversion', wins: 34, winRate: 0.85, profitFactor: 0.8, expectancyR: -0.1 }),
    ]);
    expect(good.benched).toBe(false);
    expect(good.weight).toBe(1);
    expect(trap.benched).toBe(true);
    expect(trap.weight).toBe(0);
  });

  it('benches small samples', () => {
    expect(assignWeights([stat({ trades: 4, wins: 4, winRate: 1, profitFactor: 99 })])[0].benched).toBe(true);
  });

  it('summarize computes win rate, expectancy and drawdown', () => {
    const s = summarize({ strategy: 'macd_momentum', symbol: 'X', trades: [1.5, -1, -1, 1.5].map((r) => ({ entryIndex: 0, exitIndex: 1, direction: 'long' as const, r, plannedRR: 1.5 })) }, 0);
    expect(s.winRate).toBe(0.5);
    expect(s.expectancyR).toBeCloseTo(0.25);
    expect(s.profitFactor).toBeCloseTo(1.5);
    expect(s.maxDrawdownR).toBeCloseTo(2);
  });
});

describe('symbols', () => {
  it('values a price move in account currency', () => {
    expect(valuePerPrice(specFor('EURUSD'), 1.08)).toBe(100_000);
    expect(valuePerPrice(specFor('XAUUSD'), 2700)).toBe(100);
    expect(valuePerPrice(specFor('USDJPY'), 150)).toBeCloseTo(100_000 / 150);
  });
});
