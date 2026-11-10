import type { Candle, SymbolSpec } from '../../shared/types';

/** Small deterministic PRNG so simulations and tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START: Record<string, number> = {
  EURUSD: 1.085, GBPUSD: 1.27, USDJPY: 152.0, AUDUSD: 0.655, USDCHF: 0.88, XAUUSD: 2700, XAGUSD: 31.5,
};
const VOL: Record<string, number> = {
  EURUSD: 0.00045, GBPUSD: 0.00055, USDJPY: 0.0005, AUDUSD: 0.0005, USDCHF: 0.00045, XAUUSD: 0.0009, XAGUSD: 0.0016,
};

export const TICKS_PER_CANDLE = 8;

type Regime = 'up' | 'down' | 'range';

/**
 * Synthetic price process: alternating trend and range regimes, volatility clustering and a
 * session profile (quiet Asia, active London/New York). It exists so the desk can be exercised
 * without a broker. It is not a model of any real market.
 */
export class SimMarket {
  price: number;
  private readonly rand: () => number;
  private readonly baseVol: number;
  private regime: Regime = 'range';
  private regimeLeft = 0;
  private anchor: number;
  private volMult = 1;
  private spare: number | null = null;

  constructor(readonly spec: SymbolSpec, seed: number) {
    this.rand = mulberry32(seed);
    this.price = START[spec.symbol] ?? 1;
    this.anchor = this.price;
    this.baseVol = VOL[spec.symbol] ?? 0.0005;
  }

  private gauss(): number {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u = 0;
    let v = 0;
    let r = 0;
    do { u = this.rand() * 2 - 1; v = this.rand() * 2 - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    this.spare = v * f;
    return u * f;
  }

  private nextRegime(): void {
    const x = this.rand();
    this.regime = x < 0.3 ? 'up' : x < 0.6 ? 'down' : 'range';
    this.regimeLeft = Math.floor(60 + this.rand() * 200);
    this.anchor = this.price;
  }

  /** Advance one tick; `time` (seconds) only shapes the session volatility profile. */
  tick(time: number): number {
    const hour = Math.floor((time % 86400) / 3600);
    const session = hour < 7 ? 0.65 : hour < 17 ? 1.25 : 0.9;
    this.volMult = Math.min(1.9, Math.max(0.55, this.volMult * Math.exp(0.02 * this.gauss())));
    const vol = (this.baseVol * this.volMult * session) / Math.sqrt(TICKS_PER_CANDLE);
    let drift = 0;
    if (this.regime === 'up') drift = (0.16 * this.baseVol) / TICKS_PER_CANDLE;
    else if (this.regime === 'down') drift = (-0.16 * this.baseVol) / TICKS_PER_CANDLE;
    else drift = (-0.035 * (this.price / this.anchor - 1)) / TICKS_PER_CANDLE;
    this.price *= 1 + drift + vol * this.gauss();
    return this.price;
  }

  /** Build one full candle starting at `time`. */
  candle(time: number, tf: number): Candle {
    if (this.regimeLeft-- <= 0) this.nextRegime();
    const open = this.price;
    let high = open;
    let low = open;
    for (let k = 0; k < TICKS_PER_CANDLE; k++) {
      const p = this.tick(time + (k * tf) / TICKS_PER_CANDLE);
      if (p > high) high = p;
      if (p < low) low = p;
    }
    return { time, open, high, low, close: this.price, volume: Math.round(200 + this.rand() * 800 * this.volMult) };
  }

  startCandle(): void {
    if (this.regimeLeft-- <= 0) this.nextRegime();
  }

  history(count: number, endTime: number, tf: number): Candle[] {
    const out: Candle[] = [];
    for (let i = count; i > 0; i--) out.push(this.candle(endTime - i * tf, tf));
    return out;
  }
}
