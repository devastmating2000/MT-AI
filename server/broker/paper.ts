import type { Candle, ClosedTrade, CloseReason, Position, SymbolSpec } from '../../shared/types';
import { roundPrice, valuePerPrice } from '../symbols';
import { Broker, type OrderRequest } from './types';
import { SimMarket, TICKS_PER_CANDLE } from './simMarket';

export interface PaperOptions {
  balance: number;
  candleMs: number;
  seed: number;
  timeframeSec: number;
  historyBars?: number;
}

/** Simulated venue: synthetic prices, instant fills at bid/ask, stops and targets checked per tick. */
export class PaperBroker extends Broker {
  readonly name = 'Simulador (dados sintéticos)';
  private readonly markets = new Map<string, SimMarket>();
  private readonly forming = new Map<string, Candle>();
  private readonly open = new Map<string, Position>();
  private balance: number;
  private barTime = 0;
  private tickIndex = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;

  constructor(private readonly specs: SymbolSpec[], private readonly opts: PaperOptions) {
    super();
    this.balance = opts.balance;
    specs.forEach((spec, i) => this.markets.set(spec.symbol, new SimMarket(spec, opts.seed + i * 7919)));
  }

  get connected(): boolean { return true; }

  now(): number {
    return (this.barTime + (this.tickIndex * this.opts.timeframeSec) / TICKS_PER_CANDLE) * 1000;
  }

  /** Generate history and emit it. Split from start() so tests can drive the clock by hand. */
  seed(endTimeSec = Math.floor(Date.now() / 1000)): void {
    const tf = this.opts.timeframeSec;
    this.barTime = Math.floor(endTimeSec / tf) * tf;
    for (const [symbol, market] of this.markets) {
      this.emit('history', symbol, market.history(this.opts.historyBars ?? 1500, this.barTime, tf));
    }
  }

  async start(): Promise<void> {
    this.seed();
    this.timer = setInterval(() => this.step(), this.opts.candleMs / TICKS_PER_CANDLE);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Advance the whole market by one tick; closes the candle on the last tick of the bar. */
  step(): void {
    const tf = this.opts.timeframeSec;
    const time = this.barTime + (this.tickIndex * tf) / TICKS_PER_CANDLE;
    for (const [symbol, market] of this.markets) {
      if (this.tickIndex === 0) market.startCandle();
      const before = market.price;
      const mid = market.tick(time);
      const half = (market.spec.spreadPips * market.spec.pip) / 2;
      let bar = this.forming.get(symbol);
      if (!bar || this.tickIndex === 0) {
        bar = { time: this.barTime, open: before, high: Math.max(before, mid), low: Math.min(before, mid), close: mid, volume: 1 };
        this.forming.set(symbol, bar);
      } else {
        bar.high = Math.max(bar.high, mid);
        bar.low = Math.min(bar.low, mid);
        bar.close = mid;
        bar.volume++;
      }
      const tick = { symbol, bid: roundPrice(market.spec, mid - half), ask: roundPrice(market.spec, mid + half), time: Math.round(time * 1000) };
      this.mark(tick.symbol, tick.bid, tick.ask);
      this.emit('tick', tick);
    }
    this.tickIndex++;
    if (this.tickIndex >= TICKS_PER_CANDLE) {
      this.tickIndex = 0;
      this.barTime += tf;
      for (const [symbol, bar] of this.forming) this.emit('candle', symbol, { ...bar });
    }
  }

  /** Run a whole candle synchronously (used by tests). */
  stepCandle(): void {
    for (let i = 0; i < TICKS_PER_CANDLE; i++) this.step();
  }

  private quote(symbol: string): { bid: number; ask: number; spec: SymbolSpec } {
    const market = this.markets.get(symbol);
    if (!market) throw new Error(`Símbolo desconhecido: ${symbol}`);
    const half = (market.spec.spreadPips * market.spec.pip) / 2;
    return { bid: market.price - half, ask: market.price + half, spec: market.spec };
  }

  private pnl(p: Position, exit: number, spec: SymbolSpec): number {
    const move = p.direction === 'long' ? exit - p.entryPrice : p.entryPrice - exit;
    return move * p.lots * valuePerPrice(spec, exit);
  }

  private mark(symbol: string, bid: number, ask: number): void {
    for (const p of [...this.open.values()]) {
      if (p.symbol !== symbol) continue;
      const spec = this.markets.get(symbol)!.spec;
      // Longs exit at the bid, shorts at the ask.
      const px = p.direction === 'long' ? bid : ask;
      p.pnl = this.pnl(p, px, spec);
      const stopped = p.direction === 'long' ? px <= p.stopLoss : px >= p.stopLoss;
      const target = p.direction === 'long' ? px >= p.takeProfit : px <= p.takeProfit;
      if (stopped) this.settle(p, p.stopLoss, 'sl');
      else if (target) this.settle(p, p.takeProfit, 'tp');
    }
  }

  private settle(p: Position, exit: number, reason: CloseReason): void {
    const spec = this.markets.get(p.symbol)!.spec;
    const pnl = this.pnl(p, exit, spec);
    const risk = Math.abs(p.entryPrice - p.stopLoss);
    const move = p.direction === 'long' ? exit - p.entryPrice : p.entryPrice - exit;
    this.open.delete(p.id);
    this.balance += pnl;
    const trade: ClosedTrade = {
      ...p, pnl, exitPrice: roundPrice(spec, exit), closeTime: this.now(), reason,
      rMultiple: risk > 0 ? move / risk : 0,
    };
    this.emit('closed', trade);
  }

  account() {
    let floating = 0;
    for (const p of this.open.values()) floating += p.pnl;
    return { balance: this.balance, equity: this.balance + floating, currency: 'USD' };
  }

  positions(): Position[] {
    return [...this.open.values()].map((p) => ({ ...p }));
  }

  async placeOrder(req: OrderRequest): Promise<Position> {
    const { bid, ask, spec } = this.quote(req.symbol);
    const entry = roundPrice(spec, req.direction === 'long' ? ask : bid);
    const p: Position = {
      id: `P${this.nextId++}`, symbol: req.symbol, direction: req.direction, lots: req.lots,
      entryPrice: entry, stopLoss: roundPrice(spec, req.stopLoss), takeProfit: roundPrice(spec, req.takeProfit),
      openTime: this.now(), pnl: 0, strategies: req.strategies, note: req.note,
    };
    p.pnl = this.pnl(p, req.direction === 'long' ? bid : ask, spec);
    this.open.set(p.id, p);
    return { ...p };
  }

  async closePosition(id: string, reason: CloseReason): Promise<void> {
    const p = this.open.get(id);
    if (!p) throw new Error(`Posição ${id} não encontrada`);
    const { bid, ask } = this.quote(p.symbol);
    this.settle(p, p.direction === 'long' ? bid : ask, reason);
  }
}
