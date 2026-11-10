import type { Candle } from '../../shared/types';

// All indicators return arrays aligned with the input; entries are NaN until warmed up.

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing, used by RSI, ATR and ADX. */
function wilder(values: number[], period: number, start: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < start + period) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i];
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const gains = new Array<number>(closes.length).fill(0);
  const losses = new Array<number>(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const ag = wilder(gains, period, 1);
  const al = wilder(losses, period, 1);
  return closes.map((_, i) => {
    if (Number.isNaN(ag[i])) return NaN;
    if (al[i] === 0) return ag[i] === 0 ? 50 : 100;
    return 100 - 100 / (1 + ag[i] / al[i]);
  });
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

export function atr(candles: Candle[], period = 14): number[] {
  return wilder(trueRange(candles), period, 0);
}

export function adx(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const trS = wilder(trueRange(candles), period, 1);
  const pS = wilder(plusDM, period, 1);
  const mS = wilder(minusDM, period, 1);
  const dx = new Array<number>(n).fill(NaN);
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(trS[i]) || trS[i] === 0) continue;
    const pdi = (100 * pS[i]) / trS[i];
    const mdi = (100 * mS[i]) / trS[i];
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    if (first < 0) first = i;
  }
  if (first < 0) return dx;
  const filled = dx.map((v) => (Number.isNaN(v) ? 0 : v));
  return wilder(filled, period, first);
}

export interface Macd { line: number[]; signal: number[]; hist: number[] }

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const start = line.findIndex((v) => !Number.isNaN(v));
  const signal = new Array<number>(closes.length).fill(NaN);
  if (start >= 0) {
    const sig = ema(line.slice(start), signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[start + i] = sig[i];
  }
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

export interface Bands { mid: number[]; upper: number[]; lower: number[] }

export function bollinger(closes: number[], period = 20, mult = 2): Bands {
  const mid = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/** Highest high / lowest low of the `period` bars before i (the current bar is excluded). */
export function donchian(candles: Candle[], period = 20): { high: number[]; low: number[] } {
  const high = new Array<number>(candles.length).fill(NaN);
  const low = new Array<number>(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > h) h = candles[j].high;
      if (candles[j].low < l) l = candles[j].low;
    }
    high[i] = h;
    low[i] = l;
  }
  return { high, low };
}

/** Range of the Asian session (00:00–06:59 UTC) for the UTC day each bar belongs to. */
export function asianRange(candles: Candle[]): { high: number[]; low: number[] } {
  const high = new Array<number>(candles.length).fill(NaN);
  const low = new Array<number>(candles.length).fill(NaN);
  let day = -1;
  let h = NaN;
  let l = NaN;
  let bars = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = Math.floor(candles[i].time / 86400);
    const hour = Math.floor((candles[i].time % 86400) / 3600);
    if (d !== day) { day = d; h = NaN; l = NaN; bars = 0; }
    if (hour < 7) {
      h = Number.isNaN(h) ? candles[i].high : Math.max(h, candles[i].high);
      l = Number.isNaN(l) ? candles[i].low : Math.min(l, candles[i].low);
      bars++;
    } else if (bars >= 12) {
      // Only trust the range when at least three hours of the session were seen.
      high[i] = h;
      low[i] = l;
    }
  }
  return { high, low };
}
