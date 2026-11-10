import type { Candle, Direction, StrategyId, StrategySignal, SymbolSpec } from '../../shared/types';
import { adx, asianRange, atr, bollinger, donchian, ema, macd, rsi, sma, type Bands, type Macd } from './indicators';

export interface Series {
  candles: Candle[];
  spec: SymbolSpec;
  close: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi14: number[];
  atr14: number[];
  atrAvg: number[];
  adx14: number[];
  macd: Macd;
  bb: Bands;
  don: { high: number[]; low: number[] };
  asia: { high: number[]; low: number[] };
}

export const WARMUP = 210;

export function buildSeries(candles: Candle[], spec: SymbolSpec): Series {
  const close = candles.map((c) => c.close);
  const atr14 = atr(candles, 14);
  return {
    candles, spec, close,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    atr14,
    atrAvg: sma(atr14.map((v) => (Number.isNaN(v) ? 0 : v)), 50),
    adx14: adx(candles, 14),
    macd: macd(close),
    bb: bollinger(close, 20, 2),
    don: donchian(candles, 20),
    asia: asianRange(candles),
  };
}

export interface Setup {
  direction: Direction;
  confidence: number;
  stopLoss: number;
  takeProfit: number;
  rationale: string;
}

export interface Strategy {
  id: StrategyId;
  /** Evaluate the bar at index i using only data up to and including i. */
  evaluate(s: Series, i: number): Setup | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sign = (d: Direction) => (d === 'long' ? 1 : -1);

function levels(price: number, d: Direction, stopDist: number, targetDist: number) {
  return { stopLoss: price - sign(d) * stopDist, takeProfit: price + sign(d) * targetDist };
}

/** Trade with the EMA50/200 trend after price dips to the EMA20 and rejects it. */
const trendPullback: Strategy = {
  id: 'trend_pullback',
  evaluate(s, i) {
    const c = s.candles[i];
    const a = s.atr14[i];
    if (!(a > 0) || s.adx14[i] < 18) return null;
    const up = s.ema50[i] > s.ema200[i] && c.close > s.ema200[i];
    const down = s.ema50[i] < s.ema200[i] && c.close < s.ema200[i];
    const r = s.rsi14[i];
    const strength = clamp((s.adx14[i] - 18) / 25, 0, 1);
    if (up && c.low <= s.ema20[i] && c.close > s.ema20[i] && c.close > c.open && r > 40 && r < 68) {
      return { direction: 'long', confidence: 0.5 + 0.35 * strength, ...levels(c.close, 'long', 1.5 * a, 2.25 * a),
        rationale: `Tendência de alta (EMA50 > EMA200, ADX ${s.adx14[i].toFixed(0)}); recuo à EMA20 rejeitado` };
    }
    if (down && c.high >= s.ema20[i] && c.close < s.ema20[i] && c.close < c.open && r < 60 && r > 32) {
      return { direction: 'short', confidence: 0.5 + 0.35 * strength, ...levels(c.close, 'short', 1.5 * a, 2.25 * a),
        rationale: `Tendência de baixa (EMA50 < EMA200, ADX ${s.adx14[i].toFixed(0)}); subida à EMA20 rejeitada` };
    }
    return null;
  },
};

/** Fade Bollinger-band extremes back to the mean, only when the market is not trending. */
const meanReversion: Strategy = {
  id: 'mean_reversion',
  evaluate(s, i) {
    const c = s.candles[i];
    const a = s.atr14[i];
    if (!(a > 0) || !(s.adx14[i] < 22)) return null;
    const mid = s.bb.mid[i];
    const r = s.rsi14[i];
    const calm = clamp((22 - s.adx14[i]) / 12, 0, 1);
    if (c.close < s.bb.lower[i] && r < 30 && mid - c.close >= 0.9 * a) {
      return { direction: 'long', confidence: 0.5 + 0.2 * calm + 0.15 * clamp((30 - r) / 15, 0, 1),
        stopLoss: c.close - 1.4 * a, takeProfit: mid,
        rationale: `Mercado lateral (ADX ${s.adx14[i].toFixed(0)}); fecho abaixo da banda inferior com RSI ${r.toFixed(0)}` };
    }
    if (c.close > s.bb.upper[i] && r > 70 && c.close - mid >= 0.9 * a) {
      return { direction: 'short', confidence: 0.5 + 0.2 * calm + 0.15 * clamp((r - 70) / 15, 0, 1),
        stopLoss: c.close + 1.4 * a, takeProfit: mid,
        rationale: `Mercado lateral (ADX ${s.adx14[i].toFixed(0)}); fecho acima da banda superior com RSI ${r.toFixed(0)}` };
    }
    return null;
  },
};

/** Join a close beyond the 20-bar range when volatility is expanding. */
const donchianBreakout: Strategy = {
  id: 'donchian_breakout',
  evaluate(s, i) {
    const c = s.candles[i];
    const a = s.atr14[i];
    if (!(a > 0) || s.adx14[i] < 20 || !(a > s.atrAvg[i])) return null;
    const expansion = clamp(a / s.atrAvg[i] - 1, 0, 0.6) / 0.6;
    if (c.close > s.don.high[i] && s.close[i - 1] <= s.don.high[i - 1] && c.close > s.ema50[i]) {
      return { direction: 'long', confidence: 0.45 + 0.35 * expansion, ...levels(c.close, 'long', 2 * a, 3 * a),
        rationale: 'Fecho acima do máximo de 20 velas com volatilidade em expansão' };
    }
    if (c.close < s.don.low[i] && s.close[i - 1] >= s.don.low[i - 1] && c.close < s.ema50[i]) {
      return { direction: 'short', confidence: 0.45 + 0.35 * expansion, ...levels(c.close, 'short', 2 * a, 3 * a),
        rationale: 'Fecho abaixo do mínimo de 20 velas com volatilidade em expansão' };
    }
    return null;
  },
};

/** MACD histogram crossing zero in the direction of the EMA200 trend. */
const macdMomentum: Strategy = {
  id: 'macd_momentum',
  evaluate(s, i) {
    const c = s.candles[i];
    const a = s.atr14[i];
    const h = s.macd.hist[i];
    const hp = s.macd.hist[i - 1];
    if (!(a > 0) || Number.isNaN(h) || Number.isNaN(hp)) return null;
    const push = clamp(Math.abs(h) / (0.15 * a), 0, 1);
    if (hp <= 0 && h > 0 && c.close > s.ema200[i] && s.rsi14[i] > 50) {
      return { direction: 'long', confidence: 0.45 + 0.3 * push, ...levels(c.close, 'long', 1.5 * a, 2.25 * a),
        rationale: 'Histograma MACD cruzou para positivo acima da EMA200' };
    }
    if (hp >= 0 && h < 0 && c.close < s.ema200[i] && s.rsi14[i] < 50) {
      return { direction: 'short', confidence: 0.45 + 0.3 * push, ...levels(c.close, 'short', 1.5 * a, 2.25 * a),
        rationale: 'Histograma MACD cruzou para negativo abaixo da EMA200' };
    }
    return null;
  },
};

/** First close outside the Asian-session range during the London open (07:00–10:00 UTC). */
const sessionBreakout: Strategy = {
  id: 'session_breakout',
  evaluate(s, i) {
    const c = s.candles[i];
    const a = s.atr14[i];
    const hi = s.asia.high[i];
    const lo = s.asia.low[i];
    const hour = Math.floor((c.time % 86400) / 3600);
    if (!(a > 0) || Number.isNaN(hi) || hour < 7 || hour >= 10) return null;
    const width = hi - lo;
    if (width < 1.5 * a || width > 7 * a) return null;
    const prev = s.close[i - 1];
    const mid = (hi + lo) / 2;
    if (c.close > hi && prev <= hi) {
      const risk = c.close - mid;
      return { direction: 'long', confidence: 0.55, stopLoss: mid, takeProfit: c.close + 1.5 * risk,
        rationale: 'Abertura de Londres rompeu o máximo da sessão asiática' };
    }
    if (c.close < lo && prev >= lo) {
      const risk = mid - c.close;
      return { direction: 'short', confidence: 0.55, stopLoss: mid, takeProfit: c.close - 1.5 * risk,
        rationale: 'Abertura de Londres rompeu o mínimo da sessão asiática' };
    }
    return null;
  },
};

export const STRATEGIES: Strategy[] = [trendPullback, meanReversion, donchianBreakout, macdMomentum, sessionBreakout];

/** Signals produced by the most recent closed bar. */
export function evaluateLatest(candles: Candle[], spec: SymbolSpec): StrategySignal[] {
  if (candles.length <= WARMUP) return [];
  const s = buildSeries(candles, spec);
  const i = candles.length - 1;
  const out: StrategySignal[] = [];
  for (const strat of STRATEGIES) {
    const setup = strat.evaluate(s, i);
    if (!setup) continue;
    out.push({
      strategy: strat.id, symbol: spec.symbol, direction: setup.direction,
      confidence: clamp(setup.confidence, 0, 1), entry: candles[i].close,
      stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, rationale: setup.rationale, time: candles[i].time,
    });
  }
  return out;
}
